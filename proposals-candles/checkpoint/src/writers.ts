// Event Writers for multichain proposal pool candles
// Pattern: DEX-specific handlers call shared core logic

import { evm } from '@snapshot-labs/checkpoint';
import { createPublicClient, defineChain, http } from 'viem';
import { gnosis, mainnet } from 'viem/chains';
import {
    WhitelistedToken, Proposal, Pool, Candle, Swap,
    MultiProposal, ProposalOption, OptionToken
} from '../.checkpoint/models';
import { FutarchyProposalAbi, FutarchyMultiProposalAbi, ERC20Abi } from './abis';
import {
    CHAIN_IDS,
    indexerForId,
    poolPrice,
    getSourceName,
    DexType,
    ROLE_YES_COMPANY,
    ROLE_NO_COMPANY,
    ROLE_YES_CURRENCY,
    ROLE_NO_CURRENCY,
    ROLE_COLLATERAL,
    ROLE_COMPANY,
    ROLE_OPTION_COMPANY,
    ROLE_OPTION_CURRENCY,
    isOptionRole,
    TYPE_OPTION_PRICE,
    TYPE_OPTION_PROBABILITY,
    CANDLE_PERIODS,
    convertSqrtPriceX96,
    classifyPool,
    formatPoolName,
    createId,
    TYPE_UNKNOWN
} from './adapters';

// Viem clients for each chain
const gnosisClient = createPublicClient({
    chain: gnosis,
    transport: http(process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com')
});

const mainnetClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.MAINNET_RPC_URL || 'https://eth.llamarpc.com')
});

const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const robinhoodClient = createPublicClient({
    chain: defineChain({
        id: 4663,
        name: 'Robinhood Chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } }
    }),
    transport: http(ROBINHOOD_RPC_URL)
});

const getClient = (indexer: string) =>
    indexer === 'mainnet' ? mainnetClient : indexer === 'robinhood' ? robinhoodClient : gnosisClient;

// Track which pools belong to which DEX for swap/mint/burn routing
const poolDexMap = new Map<string, DexType>();
// Track unique pool slots: proposal-type-outcomeSide → only 6 per proposal
const trackedPoolSlots = new Set<string>();

// In-memory pool cache: poolAddress → { indexer, chainId, poolId }
// Avoids 2 DB reads per swap (was: try mainnet then gnosis fallback)
interface PoolCacheEntry {
    indexer: string; chainId: number; poolId: string;
    isInverted: boolean;
    token0Symbol: string; token1Symbol: string;
    token0Decimals: number; token1Decimals: number;
}
const poolCache = new Map<string, PoolCacheEntry | null>();

// ====== DB OPTIMIZATION: In-memory candle cache ======
// Eliminates Candle.loadEntity reads (1 DB read per swap per period)
// Candles are aggregated in memory and flushed periodically
interface CandleState {
    chain: number;
    pool: string;
    time: number;
    period: number;
    periodStartUnix: number;
    block: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volumeToken0: string;
    volumeToken1: string;
    indexer: string;
    dirty: boolean;
}
const candleCache = new Map<string, CandleState>();
const SKIP_SWAP_STORAGE = process.env.SKIP_SWAP_STORAGE === 'true';
const CANDLE_FLUSH_INTERVAL = parseInt(process.env.CANDLE_FLUSH_INTERVAL || '50'); // flush every N swaps (backfill batching)
// Blocks younger than this are "at head": flush candles on every swap so the
// API never serves stale closes. Batching only pays off during backfill —
// sparse futarchy pools (~2 swaps/day) otherwise leave dirty candles in
// memory for days (observed live: NO-pool candle missing hours after its swap).
const CANDLE_FLUSH_HEAD_SECONDS = parseInt(process.env.CANDLE_FLUSH_HEAD_SECONDS || '300');
let swapsSinceFlush = 0;

// Pool state cache: poolId → pool fields (avoids pool.save on every swap)
interface PoolState {
    sqrtPrice: string;
    price: string;
    liquidity: string;
    tick: number;
    volumeToken0: string;
    volumeToken1: string;
    dirty: boolean;
}
const poolStateCache = new Map<string, PoolState>();

async function flushCandles(): Promise<void> {
    const dirtyCandles = [...candleCache.entries()].filter(([_, c]) => c.dirty);
    if (dirtyCandles.length === 0) return;

    for (const [candleId, state] of dirtyCandles) {
        const candle = new Candle(candleId, state.indexer);
        candle.chain = state.chain;
        candle.pool = state.pool;
        candle.time = state.time;
        candle.period = state.period;
        candle.periodStartUnix = state.periodStartUnix;
        candle.block = state.block;
        candle.open = state.open;
        candle.high = state.high;
        candle.low = state.low;
        candle.close = state.close;
        candle.volumeToken0 = state.volumeToken0;
        candle.volumeToken1 = state.volumeToken1;
        await candle.save();
        state.dirty = false;
    }
}

async function flushPoolStates(): Promise<void> {
    for (const [poolId, state] of poolStateCache.entries()) {
        if (!state.dirty) continue;
        // Figure out which indexer from the poolId prefix
        const indexer = indexerForId(poolId);
        const pool = await Pool.loadEntity(poolId, indexer);
        if (!pool) continue;
        pool.sqrtPrice = state.sqrtPrice;
        pool.price = state.price;
        pool.liquidity = state.liquidity;
        pool.tick = state.tick;
        pool.volumeToken0 = state.volumeToken0;
        pool.volumeToken1 = state.volumeToken1;
        await pool.save();
        await updateOptionQuote(indexer, poolId, pool, state.price);
        state.dirty = false;
    }
}

async function getOrCreateCandleState(
    indexer: string,
    chainId: number,
    poolId: string,
    period: number,
    periodStart: number,
    timestamp: number,
    blockNum: number,
    priceStr: string
): Promise<CandleState> {
    const candleId = `${poolId}-${period}-${periodStart}`;
    let candle = candleCache.get(candleId);
    if (candle) return candle;

    const existing = await Candle.loadEntity(candleId, indexer);
    if (existing) {
        candle = {
            chain: existing.chain,
            pool: existing.pool,
            time: existing.time,
            period: existing.period,
            periodStartUnix: existing.periodStartUnix,
            block: existing.block,
            open: existing.open,
            high: existing.high,
            low: existing.low,
            close: existing.close,
            volumeToken0: existing.volumeToken0,
            volumeToken1: existing.volumeToken1,
            indexer,
            dirty: false
        };
    } else {
        candle = {
            chain: chainId,
            pool: poolId,
            time: timestamp,
            period,
            periodStartUnix: periodStart,
            block: blockNum,
            open: priceStr,
            high: priceStr,
            low: priceStr,
            close: priceStr,
            volumeToken0: '0',
            volumeToken1: '0',
            indexer,
            dirty: true
        };
    }

    candleCache.set(candleId, candle);
    return candle;
}

async function seedInitialCandles(
    indexer: string,
    chainId: number,
    poolId: string,
    timestamp: number,
    blockNum: number,
    priceStr: string
): Promise<void> {
    for (const period of CANDLE_PERIODS) {
        const periodStart = Math.floor(timestamp / period) * period;
        await getOrCreateCandleState(indexer, chainId, poolId, period, periodStart, timestamp, blockNum, priceStr);
    }

    await flushCandles();
}

function lookupPoolCache(poolAddr: string): PoolCacheEntry | null | undefined {
    return poolCache.get(poolAddr);
}

async function resolvePool(poolAddr: string): Promise<PoolCacheEntry | null> {
    const cached = poolCache.get(poolAddr);
    if (cached !== undefined) return cached; // null = known missing

    // Try both chains
    for (const [indexer, chainId] of [['mainnet', 1], ['robinhood', 4663], ['gnosis', 100]] as const) {
        const poolId = `${chainId}-${poolAddr}`;
        const pool = await Pool.loadEntity(poolId, indexer);
        if (pool) {
            // Load token symbols/decimals once and cache
            const wt0 = await WhitelistedToken.loadEntity(pool.token0 || '', indexer);
            const wt1 = await WhitelistedToken.loadEntity(pool.token1 || '', indexer);
            const entry: PoolCacheEntry = {
                indexer, chainId, poolId,
                isInverted: !!pool.isInverted,
                token0Symbol: wt0?.symbol || 'T0',
                token1Symbol: wt1?.symbol || 'T1',
                token0Decimals: wt0?.decimals ?? 18,
                token1Decimals: wt1?.decimals ?? 18,
            };
            poolCache.set(poolAddr, entry);
            return entry;
        }
    }

    poolCache.set(poolAddr, null); // Cache miss too
    return null;
}

// ============================================================================
// FUTARCHY PROTOCOL HANDLERS (Shared across chains)
// ============================================================================

export const handleNewProposal: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const indexer = getSourceName(source);
    const args = (event as any).args;

    // Debug: Log full event structure to understand indexed params
    console.log(`[${indexer}] DEBUG NewProposal event:`, JSON.stringify({
        args: args,
        topics: (event as any).topics,
        address: (event as any).address,
        keys: args ? Object.keys(args) : 'no args'
    }, null, 2));

    const proposalAddr = (args?.proposal as string)?.toLowerCase();
    const marketName = args?.marketName;
    const chainId = CHAIN_IDS[indexer] || 100;

    if (!proposalAddr) {
        console.log(`[${indexer}] WARNING: proposalAddr is undefined/null, skipping`);
        return;
    }

    console.log(`[${indexer}] NewProposal: ${proposalAddr}`);

    const client = getClient(indexer);
    const proposalId = createId(chainId, proposalAddr);

    try {
        // Get collateral tokens from proposal contract
        const [collateral1, collateral2] = await Promise.all([
            client.readContract({ address: proposalAddr as `0x${string}`, abi: FutarchyProposalAbi, functionName: 'collateralToken1' } as any).catch(() => null),
            client.readContract({ address: proposalAddr as `0x${string}`, abi: FutarchyProposalAbi, functionName: 'collateralToken2' } as any).catch(() => null)
        ]);

        // Whitelist collateral tokens
        if (collateral1) {
            await saveToken(indexer, collateral1 as string, ROLE_COMPANY, null, client);
        }
        if (collateral2) {
            await saveToken(indexer, collateral2 as string, ROLE_COLLATERAL, null, client);
        }

        // Get 4 wrapped outcome tokens
        const roles = [ROLE_YES_COMPANY, ROLE_NO_COMPANY, ROLE_YES_CURRENCY, ROLE_NO_CURRENCY];
        const outcomeTokenIds: string[] = [];

        for (let i = 0; i < 4; i++) {
            try {
                const outcome = await client.readContract({
                    address: proposalAddr as `0x${string}`,
                    abi: FutarchyProposalAbi,
                    functionName: 'wrappedOutcome',
                    args: [BigInt(i)]
                } as any) as any;

                // New ABI returns (address wrapped1155, bytes data)
                // outcome is an array: [wrapped1155Address, dataBytes]
                // or object: { wrapped1155, data }
                const tokenAddress = outcome[0] || outcome.wrapped1155;

                console.log(`[${indexer}] wrappedOutcome[${i}]: ${tokenAddress}`);

                if (tokenAddress && tokenAddress !== '0x0000000000000000000000000000000000000000') {
                    await saveToken(indexer, tokenAddress, roles[i], proposalId, client);
                    outcomeTokenIds.push(createId(chainId, tokenAddress));
                }
            } catch (err) {
                console.log(`[${indexer}] wrappedOutcome[${i}] failed:`, (err as any)?.message || err);
            }
        }

        // Create proposal entity
        const proposal = new Proposal(proposalId, indexer);
        proposal.chain = chainId;
        proposal.address = proposalAddr;
        proposal.marketName = marketName || '';
        proposal.companyToken = collateral1 ? createId(chainId, collateral1 as string) : '';
        proposal.currencyToken = collateral2 ? createId(chainId, collateral2 as string) : '';
        proposal.outcomeTokens = JSON.stringify(outcomeTokenIds);
        await proposal.save();

        console.log(`✅ [${indexer}] Whitelisted tokens for proposal ${proposalAddr} (${outcomeTokenIds.length} outcome tokens)`);
    } catch (err) {
        console.error(`❌ [${indexer}] Error processing proposal ${proposalAddr}:`, err);
    }
};


async function saveToken(
    indexer: string,
    address: string,
    role: string,
    proposalId: string | null,
    client: any
) {
    const chainId = CHAIN_IDS[indexer] || 100;
    const tokenId = createId(chainId, address);

    // Skip if token already exists (same token can be in multiple proposals)
    const existing = await WhitelistedToken.loadEntity(tokenId, indexer);
    if (existing) {
        console.log(`[${indexer}] Token already exists: ${tokenId}`);
        return;
    }

    let symbol = 'UNKNOWN';
    let decimals = 18;

    try {
        const [sym, dec] = await Promise.all([
            client.readContract({ address: address as `0x${string}`, abi: ERC20Abi, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
            client.readContract({ address: address as `0x${string}`, abi: ERC20Abi, functionName: 'decimals' }).catch(() => 18)
        ]);
        symbol = sym as string;
        decimals = Number(dec);
    } catch {
        console.warn(`[${indexer}] Could not fetch token metadata for ${address}`);
    }

    const token = new WhitelistedToken(tokenId, indexer);
    token.chain = chainId;
    token.address = address.toLowerCase();
    token.symbol = symbol;
    token.decimals = decimals;
    token.role = role;
    token.proposal = proposalId;
    await token.save();

    console.log(`[${indexer}] Whitelisted: ${tokenId} (${symbol}) as ${role}`);
}

// ============================================================================
// MULTI-OPTION MARKETS (FutarchyMultiFactory)
// ============================================================================

// poolId -> the option it prices (null = not an option pool). Rebuilt lazily
// from the database after a restart.
const optionPoolIndex = new Map<string, { optionId: string; isPrice: boolean } | null>();

/**
 * NewMultiProposal: N options over two collateral tokens, so 2N outcome
 * tokens. wrappedOutcome(i) is option i for collateral 1 when i < N and
 * option i - N for collateral 2 otherwise.
 */
export const handleNewMultiProposal: evm.Writer = async ({ event, source }) => {
    if (!event) return;

    const indexer = getSourceName(source);
    const args = (event as any).args;
    const proposalAddr = (args?.proposal as string)?.toLowerCase();
    if (!proposalAddr) {
        console.log(`[${indexer}] WARNING: NewMultiProposal without a proposal address, skipping`);
        return;
    }

    const chainId = CHAIN_IDS[indexer] || 100;
    const proposalId = createId(chainId, proposalAddr);
    const factory = ((event as any).address as string || '').toLowerCase();
    const client = getClient(indexer);
    const address = proposalAddr as `0x${string}`;
    const read = (functionName: string, fnArgs: any[] = []) =>
        client.readContract({ address, abi: FutarchyMultiProposalAbi, functionName, args: fnArgs } as any);

    console.log(`[${indexer}] NewMultiProposal: ${proposalAddr}`);

    try {
        const [numOutcomes, collateral1, collateral2, parentMarket, parentOutcome] = await Promise.all([
            read('numOutcomes'), read('collateralToken1'), read('collateralToken2'),
            read('parentMarket'), read('parentOutcome')
        ]) as [bigint, string, string, string, bigint];
        const n = Number(numOutcomes);

        await saveToken(indexer, collateral1, ROLE_COMPANY, null, client);
        await saveToken(indexer, collateral2, ROLE_COLLATERAL, null, client);

        const hasParent = !!parentMarket && !/^0x0{40}$/i.test(parentMarket);
        const parentId = hasParent ? createId(chainId, parentMarket) : null;
        const parentOptionId = parentId ? `${parentId}-${Number(parentOutcome)}` : null;

        const outcomeTokenIds: string[] = [];
        for (let i = 0; i < n; i++) {
            const [name, symbol, companyOutcome, currencyOutcome] = await Promise.all([
                read('outcomes', [BigInt(i)]), read('outcomeSymbols', [BigInt(i)]),
                read('wrappedOutcome', [BigInt(i)]), read('wrappedOutcome', [BigInt(n + i)])
            ]) as [string, string, any, any];
            const companyToken = ((companyOutcome[0] || companyOutcome.token) as string).toLowerCase();
            const currencyToken = ((currencyOutcome[0] || currencyOutcome.token) as string).toLowerCase();
            const optionId = `${proposalId}-${i}`;

            for (const [tokenAddr, role] of [[companyToken, ROLE_OPTION_COMPANY], [currencyToken, ROLE_OPTION_CURRENCY]]) {
                await saveToken(indexer, tokenAddr, role, proposalId, client);
                const tokenId = createId(chainId, tokenAddr);
                const wt = await WhitelistedToken.loadEntity(tokenId, indexer);
                const optionToken = new OptionToken(tokenId, indexer);
                optionToken.chain = chainId;
                optionToken.address = tokenAddr;
                optionToken.symbol = wt?.symbol || 'UNKNOWN';
                optionToken.decimals = wt?.decimals ?? 18;
                optionToken.role = role;
                optionToken.proposal = proposalId;
                optionToken.optionIndex = i;
                optionToken.optionSymbol = symbol;
                optionToken.option = optionId;
                await optionToken.save();
                outcomeTokenIds.push(tokenId);
            }

            const option = new ProposalOption(optionId, indexer);
            option.chain = chainId;
            option.proposal = proposalId;
            option.optionIndex = i;
            option.name = name;
            option.symbol = symbol;
            option.companyToken = createId(chainId, companyToken);
            option.currencyToken = createId(chainId, currencyToken);
            await option.save();
        }

        const multi = new MultiProposal(proposalId, indexer);
        multi.chain = chainId;
        multi.address = proposalAddr;
        multi.marketName = args?.marketName || '';
        multi.factory = factory;
        multi.questionId = (args?.questionId as string) || '';
        multi.conditionId = (args?.conditionId as string) || '';
        multi.companyToken = createId(chainId, collateral1);
        multi.currencyToken = createId(chainId, collateral2);
        multi.numOptions = n;
        if (parentId) {
            multi.parentProposal = parentId;
            multi.parentOutcome = Number(parentOutcome);
            multi.parentOption = parentOptionId;
        }
        await multi.save();

        // Also a plain Proposal row, so queries by proposal work as for two-option markets.
        const proposal = new Proposal(proposalId, indexer);
        proposal.chain = chainId;
        proposal.address = proposalAddr;
        proposal.marketName = args?.marketName || '';
        proposal.companyToken = createId(chainId, collateral1);
        proposal.currencyToken = createId(chainId, collateral2);
        proposal.outcomeTokens = JSON.stringify(outcomeTokenIds);
        await proposal.save();

        // Link the parent option to this market.
        if (parentOptionId) {
            const parentOption = await ProposalOption.loadEntity(parentOptionId, indexer);
            if (parentOption) {
                parentOption.childProposal = proposalId;
                await parentOption.save();
            } else {
                console.log(`[${indexer}] WARNING: parent option ${parentOptionId} of ${proposalAddr} is not indexed`);
            }
        }

        console.log(`✅ [${indexer}] Multi-option proposal ${proposalAddr}: ${n} options`);
    } catch (err) {
        console.error(`❌ [${indexer}] Error processing multi-option proposal ${proposalAddr}:`, err);
        throw err;
    }
};

/**
 * Classify a pool that holds at least one option token.
 *   OPTION_PRICE        <k>_company / <k>_currency of the same option: currency per company token.
 *   OPTION_PROBABILITY  <k>_currency against the token it is split from: the currency collateral
 *                       for a root market, the parent option's currency token for a child market.
 * Returns null for any other pair.
 */
async function classifyOptionPool(
    indexer: string,
    token0Id: string,
    token1Id: string,
    role0: string,
    role1: string
): Promise<{ type: string; isInverted: boolean; outcomeSide: string; proposalId: string; optionId: string } | null> {
    const o0 = isOptionRole(role0) ? await OptionToken.loadEntity(token0Id, indexer) : null;
    const o1 = isOptionRole(role1) ? await OptionToken.loadEntity(token1Id, indexer) : null;

    // Price pool: both tokens of one option.
    if (o0 && o1 && o0.proposal === o1.proposal && o0.optionIndex === o1.optionIndex && o0.role !== o1.role) {
        return {
            type: TYPE_OPTION_PRICE,
            // Quote is the currency token, so invert when it is token0.
            isInverted: o0.role === ROLE_OPTION_CURRENCY,
            outcomeSide: o0.optionSymbol,
            proposalId: o0.proposal,
            optionId: o0.option
        };
    }

    // Probability pool of a root market: option currency token against the currency collateral.
    const single = o0 && !o1 ? o0 : !o0 && o1 ? o1 : null;
    if (single && single.role === ROLE_OPTION_CURRENCY) {
        const otherRole = single === o0 ? role1 : role0;
        const market = await MultiProposal.loadEntity(single.proposal, indexer);
        if (otherRole === ROLE_COLLATERAL && market && !market.parentProposal) {
            return {
                type: TYPE_OPTION_PROBABILITY,
                // Price is "what it is split from" per option token, so invert when the option token is token1.
                isInverted: single === o1,
                outcomeSide: single.optionSymbol,
                proposalId: single.proposal,
                optionId: single.option
            };
        }
        return null;
    }

    // Probability pool of a child market: its option currency token against the parent option's currency token.
    if (o0 && o1 && o0.role === ROLE_OPTION_CURRENCY && o1.role === ROLE_OPTION_CURRENCY && o0.proposal !== o1.proposal) {
        for (const [child, parent] of [[o0, o1], [o1, o0]] as const) {
            const market = await MultiProposal.loadEntity(child.proposal, indexer);
            if (market && market.parentProposal === parent.proposal && market.parentOutcome === parent.optionIndex) {
                return {
                    type: TYPE_OPTION_PROBABILITY,
                    isInverted: child === o1,
                    outcomeSide: child.optionSymbol,
                    proposalId: child.proposal,
                    optionId: child.option
                };
            }
        }
    }

    return null;
}

/** Copy an option pool's latest price onto its ProposalOption row. No-op for every other pool. */
async function updateOptionQuote(indexer: string, poolId: string, pool: Pool, priceStr: string): Promise<void> {
    if (pool.type !== TYPE_OPTION_PRICE && pool.type !== TYPE_OPTION_PROBABILITY) return;

    let entry = optionPoolIndex.get(poolId);
    if (entry === undefined) {
        entry = null;
        for (const tokenId of [pool.token0, pool.token1]) {
            const optionToken = await OptionToken.loadEntity(tokenId || '', indexer);
            if (optionToken && optionToken.proposal === pool.proposal) {
                entry = { optionId: optionToken.option, isPrice: pool.type === TYPE_OPTION_PRICE };
                break;
            }
        }
        optionPoolIndex.set(poolId, entry);
    }
    if (!entry) return;

    const option = await ProposalOption.loadEntity(entry.optionId, indexer);
    if (!option) return;
    if (entry.isPrice) option.price = priceStr;
    else option.probability = priceStr;
    await option.save();
}

// ============================================================================
// DEX-SPECIFIC POOL CREATION HANDLERS
// ============================================================================

export const handleAlgebraPoolCreated: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const indexer = getSourceName(source);
    const args = (event as any).args;
    const token0 = (args?.token0 as string)?.toLowerCase();
    const token1 = (args?.token1 as string)?.toLowerCase();
    const poolAddr = (args?.pool as string)?.toLowerCase();

    await createPoolEntity(indexer, poolAddr, token0, token1, 'ALGEBRA', null, blockNumber, helpers);
};

export const handleUniswapPoolCreated: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const indexer = getSourceName(source);
    const args = (event as any).args;
    const token0 = (args?.token0 as string)?.toLowerCase();
    const token1 = (args?.token1 as string)?.toLowerCase();
    const fee = args?.fee?.toString();
    const poolAddr = (args?.pool as string)?.toLowerCase();

    await createPoolEntity(indexer, poolAddr, token0, token1, 'UNISWAP_V3', fee, blockNumber, helpers);
};

async function createPoolEntity(
    indexer: string,
    poolAddr: string,
    token0: string,
    token1: string,
    dex: DexType,
    fee: string | null,
    blockNumber: number | bigint,
    helpers: any
) {
    const chainId = CHAIN_IDS[indexer] || 100;
    const poolId = createId(chainId, poolAddr);
    const token0Id = createId(chainId, token0);
    const token1Id = createId(chainId, token1);

    // Check if both tokens are whitelisted
    const wt0 = await WhitelistedToken.loadEntity(token0Id, indexer);
    const wt1 = await WhitelistedToken.loadEntity(token1Id, indexer);

    if (!wt0 || !wt1) {
        // Skip non-Futarchy pools
        return;
    }

    // Track DEX type
    poolDexMap.set(poolId, dex);

    let type: string;
    let isInverted: boolean;
    let outcomeSide: string | null;
    let proposalId: string;
    // Multi-option markets only: the option this pool belongs to.
    let optionId: string | null = null;

    if (isOptionRole(wt0.role) || isOptionRole(wt1.role)) {
        const optionPool = await classifyOptionPool(indexer, token0Id, token1Id, wt0.role || '', wt1.role || '');
        if (!optionPool) {
            return;
        }
        ({ type, isInverted, outcomeSide, proposalId, optionId } = optionPool);
    } else {
        // Classify pool type
        ({ type, isInverted, outcomeSide } = classifyPool(wt0.role || '', wt1.role || ''));

        // Skip pools with unknown type (e.g. COMPANY+COMPANY, COLLATERAL+COLLATERAL)
        if (type === TYPE_UNKNOWN) {
            return;
        }

        // Verify tokens belong to the same proposal (prevent cross-proposal pool tracking)
        // For CONDITIONAL pools: both tokens have proposals, they must match
        // For EXPECTED_VALUE/PREDICTION: one token is COLLATERAL (no proposal), other has proposal
        const prop0 = wt0.proposal || '';
        const prop1 = wt1.proposal || '';
        if (prop0 && prop1 && prop0 !== prop1) {
            // Outcome tokens from different proposals — skip
            return;
        }
        proposalId = prop0 || prop1;
        if (!proposalId) {
            // No proposal linked — skip
            return;
        }
    }

    const name = formatPoolName(wt0.symbol || 'T0', wt1.symbol || 'T1', isInverted);

    // Skip if pool already exists (block retries can re-emit the same event)
    const existingPool = await Pool.loadEntity(poolId, indexer);
    if (existingPool) {
        return;
    }

    // Ensure only ONE pool per proposal+type+outcomeSide combination (max 6 per proposal)
    const slotKey = `${proposalId}-${type}-${outcomeSide || 'NONE'}`;
    if (trackedPoolSlots.has(slotKey)) {
        return;
    }
    trackedPoolSlots.add(slotKey);

    // Create pool entity
    const pool = new Pool(poolId, indexer);
    pool.chain = chainId;
    pool.address = poolAddr;
    pool.dex = dex;
    pool.token0 = token0Id;
    pool.token1 = token1Id;
    pool.fee = fee || '';
    pool.liquidity = '0';
    pool.sqrtPrice = '0';
    pool.price = '0';
    pool.tick = 0;
    pool.isInverted = isInverted ? 1 : 0;
    pool.name = name;
    pool.type = type;
    pool.outcomeSide = outcomeSide;
    pool.volumeToken0 = '0';
    pool.volumeToken1 = '0';
    pool.proposal = proposalId;
    await pool.save();

    if (optionId) {
        const option = await ProposalOption.loadEntity(optionId, indexer);
        if (option) {
            if (type === TYPE_OPTION_PRICE) option.pricePool = poolId;
            else option.probabilityPool = poolId;
            await option.save();
        }
        optionPoolIndex.set(poolId, { optionId, isPrice: type === TYPE_OPTION_PRICE });
    }

    // Start tracking pool events via template
    const templateName = dex === 'ALGEBRA' ? 'AlgebraPool' : 'UniswapV3Pool';
    await helpers.executeTemplate(templateName, { contract: poolAddr, start: blockNumber });

    console.log(`✅ [${indexer}] Created ${dex} pool: ${poolId} (${name})`);
}

// ============================================================================
// SHARED POOL EVENT HANDLERS
// ============================================================================

export const handleInitialize: evm.Writer = async ({ event, source, block }) => {
    if (!event) return;

    const poolAddr = (event as any).address?.toLowerCase();
    const resolved = await resolvePool(poolAddr);
    if (!resolved) return;

    const { indexer, chainId, poolId } = resolved;
    const pool = await Pool.loadEntity(poolId, indexer);
    if (!pool) return;

    const args = (event as any).args;
    const sqrtPriceX96 = BigInt((args?.[0] || args?.price || args?.sqrtPriceX96 || 0).toString());
    const tick = Number(args?.[1] || args?.tick || 0);
    const price = poolPrice(sqrtPriceX96, resolved.token0Decimals, resolved.token1Decimals);
    // Invert price if needed
    const finalPrice = pool.isInverted ? (price === 0 ? 0 : 1 / price) : price;
    const priceStr = finalPrice.toString();
    const timestamp = Number(block?.timestamp || Math.floor(Date.now() / 1000));
    const blockNum = Number(block?.number || 0);

    pool.sqrtPrice = sqrtPriceX96.toString();
    pool.price = priceStr;
    pool.tick = tick;
    await pool.save();
    await updateOptionQuote(indexer, poolId, pool, priceStr);

    if (finalPrice > 0) {
        await seedInitialCandles(indexer, chainId, poolId, timestamp, blockNum, priceStr);
    }

    console.log(`[${indexer}] Initialize pool ${chainId}-${poolAddr}: price=${price.toFixed(8)}`);
};

export const handleSwap: evm.Writer = async ({ event, source, block }) => {
    if (!event) return;

    const poolAddr = (event as any).address?.toLowerCase();

    // Use in-memory cache — includes isInverted + token symbols/decimals
    const resolved = await resolvePool(poolAddr);
    if (!resolved) return;

    const { indexer, chainId, poolId, isInverted, token0Symbol, token1Symbol, token0Decimals, token1Decimals } = resolved;

    const args = (event as any).args;
    const amount0 = BigInt((args?.amount0 || 0).toString());
    const amount1 = BigInt((args?.amount1 || 0).toString());
    const sqrtPriceX96 = BigInt((args?.[4] || args?.price || args?.sqrtPriceX96 || 0).toString());
    const liquidity = BigInt((args?.[5] || args?.liquidity || 0).toString());
    const tick = Number(args?.[6] || args?.tick || 0);

    const price = poolPrice(sqrtPriceX96, token0Decimals, token1Decimals);
    const timestamp = Number(block?.timestamp || Math.floor(Date.now() / 1000));
    const blockNum = Number(block?.number || 0);

    // Invert price if needed (from cached pool data — no DB read)
    const finalPrice = isInverted ? (price === 0 ? 0 : 1 / price) : price;
    const priceStr = finalPrice.toString();

    // Determine swap direction and resolve token symbols
    const isToken0In = amount0 > 0n;
    const symbolIn = isToken0In ? token0Symbol : token1Symbol;
    const symbolOut = isToken0In ? token1Symbol : token0Symbol;
    const decimalsIn = isToken0In ? token0Decimals : token1Decimals;
    const decimalsOut = isToken0In ? token1Decimals : token0Decimals;

    // ===== OPTIMIZATION 1: Skip swap storage (saves 1 DB write per swap) =====
    if (!SKIP_SWAP_STORAGE) {
        const sender = (args?.sender as string)?.toLowerCase() || '';
        const recipient = (args?.recipient as string)?.toLowerCase() || '';
        const txHash = (event as any).transactionHash || '';
        const logIndex = (event as any).logIndex || 0;
        const swapId = `${poolId}-${txHash}-${logIndex}`;

        const swap = new Swap(swapId, indexer);
        swap.chain = chainId;
        swap.transactionHash = txHash;
        swap.timestamp = timestamp;
        swap.pool = poolId;
        swap.sender = sender;
        swap.recipient = recipient;
        swap.origin = sender;
        swap.amount0 = amount0.toString();
        swap.amount1 = amount1.toString();
        // amountIn/Out must follow the swap direction, not always amount0/amount1
        swap.amountIn = isToken0In
            ? amount0.toString()
            : (amount1 < 0n ? (-amount1).toString() : amount1.toString());
        swap.amountOut = isToken0In
            ? (amount1 < 0n ? (-amount1).toString() : amount1.toString())
            : (amount0 < 0n ? (-amount0).toString() : amount0.toString());
        swap.tokenIn = isToken0In ? 'token0' : 'token1';
        swap.tokenOut = isToken0In ? 'token1' : 'token0';
        swap.symbolIn = symbolIn;
        swap.symbolOut = symbolOut;
        swap.decimalsIn = decimalsIn;
        swap.decimalsOut = decimalsOut;
        swap.price = priceStr;
        await swap.save();
    }

    // ===== OPTIMIZATION 2: Pool state in memory (saves 1 read + 1 write per swap) =====
    let poolState = poolStateCache.get(poolId);
    if (!poolState) {
        // First time: load from DB to seed the cache
        const pool = await Pool.loadEntity(poolId, indexer);
        if (!pool) return;
        poolState = {
            sqrtPrice: pool.sqrtPrice || '0',
            price: pool.price || '0',
            liquidity: pool.liquidity || '0',
            tick: pool.tick || 0,
            volumeToken0: pool.volumeToken0 || '0',
            volumeToken1: pool.volumeToken1 || '0',
            dirty: false
        };
        poolStateCache.set(poolId, poolState);
    }
    poolState.sqrtPrice = sqrtPriceX96.toString();
    poolState.price = priceStr;
    poolState.liquidity = liquidity.toString();
    poolState.tick = tick;
    poolState.volumeToken0 = (BigInt(poolState.volumeToken0) + (amount0 < 0n ? -amount0 : amount0)).toString();
    poolState.volumeToken1 = (BigInt(poolState.volumeToken1) + (amount1 < 0n ? -amount1 : amount1)).toString();
    poolState.dirty = true;

    // ===== OPTIMIZATION 3: Candles in memory (saves 1 read + 1 write per swap per period) =====
    const absAmount0 = amount0 < 0n ? -amount0 : amount0;
    const absAmount1 = amount1 < 0n ? -amount1 : amount1;

    for (const period of CANDLE_PERIODS) {
        const periodStart = Math.floor(timestamp / period) * period;
        const candle = await getOrCreateCandleState(
            indexer,
            chainId,
            poolId,
            period,
            periodStart,
            timestamp,
            blockNum,
            priceStr
        );
        candle.close = priceStr;
        candle.time = timestamp;
        candle.block = blockNum;
        if (parseFloat(priceStr) > parseFloat(candle.high)) candle.high = priceStr;
        if (parseFloat(priceStr) < parseFloat(candle.low)) candle.low = priceStr;
        candle.dirty = true;
        candle.volumeToken0 = (BigInt(candle.volumeToken0) + absAmount0).toString();
        candle.volumeToken1 = (BigInt(candle.volumeToken1) + absAmount1).toString();
    }

    // ===== Periodic flush: write dirty candles + pools to DB =====
    swapsSinceFlush++;
    const atHead = Math.floor(Date.now() / 1000) - timestamp <= CANDLE_FLUSH_HEAD_SECONDS;
    if (atHead || swapsSinceFlush >= CANDLE_FLUSH_INTERVAL) {
        await flushCandles();
        await flushPoolStates();
        swapsSinceFlush = 0;
    }
};

export const handleMint: evm.Writer = async ({ event, source }) => {
    if (!event) return;

    const poolAddr = (event as any).address?.toLowerCase();

    // Try both chain IDs since template events don't include indexer info
    let pool = await Pool.loadEntity(`1-${poolAddr}`, 'mainnet');
    let indexer = 'mainnet';
    let poolId = `1-${poolAddr}`;

    if (!pool) {
        pool = await Pool.loadEntity(`4663-${poolAddr}`, 'robinhood');
        indexer = 'robinhood';
        poolId = `4663-${poolAddr}`;
    }

    if (!pool) {
        pool = await Pool.loadEntity(`100-${poolAddr}`, 'gnosis');
        indexer = 'gnosis';
        poolId = `100-${poolAddr}`;
    }

    if (!pool) return;

    const args = (event as any).args;
    const liquidityDelta = BigInt((args?.[4] || args?.liquidityAmount || args?.amount || 0).toString());

    pool.liquidity = (BigInt(pool.liquidity || '0') + liquidityDelta).toString();
    await pool.save();

    console.log(`[${indexer}] Mint on ${poolId}: +${liquidityDelta.toString()}`);
};

export const handleBurn: evm.Writer = async ({ event, source }) => {
    if (!event) return;

    const poolAddr = (event as any).address?.toLowerCase();

    // Try both chain IDs since template events don't include indexer info
    let pool = await Pool.loadEntity(`1-${poolAddr}`, 'mainnet');
    let indexer = 'mainnet';
    let poolId = `1-${poolAddr}`;

    if (!pool) {
        pool = await Pool.loadEntity(`4663-${poolAddr}`, 'robinhood');
        indexer = 'robinhood';
        poolId = `4663-${poolAddr}`;
    }

    if (!pool) {
        pool = await Pool.loadEntity(`100-${poolAddr}`, 'gnosis');
        indexer = 'gnosis';
        poolId = `100-${poolAddr}`;
    }

    if (!pool) return;

    const args = (event as any).args;
    const liquidityDelta = BigInt((args?.[3] || args?.liquidityAmount || args?.amount || 0).toString());

    const currentLiq = BigInt(pool.liquidity || '0');
    pool.liquidity = (currentLiq > liquidityDelta ? currentLiq - liquidityDelta : 0n).toString();
    await pool.save();

    console.log(`[${indexer}] Burn on ${poolId}: -${liquidityDelta.toString()}`);
};
