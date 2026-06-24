// Event Writers for multichain proposal pool candles
// Pattern: DEX-specific handlers call shared core logic

import { evm } from '@snapshot-labs/checkpoint';
import { createPublicClient, http } from 'viem';
import { gnosis, mainnet } from 'viem/chains';
import { WhitelistedToken, Proposal, Pool, Candle, Swap } from '../.checkpoint/models';
import { FutarchyProposalAbi, ERC20Abi } from './abis';
import {
    CHAIN_IDS,
    getSourceName,
    DexType,
    ROLE_YES_COMPANY,
    ROLE_NO_COMPANY,
    ROLE_YES_CURRENCY,
    ROLE_NO_CURRENCY,
    ROLE_COLLATERAL,
    ROLE_COMPANY,
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

const getClient = (indexer: string) => indexer === 'mainnet' ? mainnetClient : gnosisClient;

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
const CANDLE_FLUSH_INTERVAL = parseInt(process.env.CANDLE_FLUSH_INTERVAL || '50'); // flush every N swaps
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
        const indexer = poolId.startsWith('1-') ? 'mainnet' : 'gnosis';
        const pool = await Pool.loadEntity(poolId, indexer);
        if (!pool) continue;
        pool.sqrtPrice = state.sqrtPrice;
        pool.price = state.price;
        pool.liquidity = state.liquidity;
        pool.tick = state.tick;
        pool.volumeToken0 = state.volumeToken0;
        pool.volumeToken1 = state.volumeToken1;
        await pool.save();
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
    for (const [indexer, chainId] of [['mainnet', 1], ['gnosis', 100]] as const) {
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
            client.readContract({ address: proposalAddr as `0x${string}`, abi: FutarchyProposalAbi, functionName: 'collateralToken1' }).catch(() => null),
            client.readContract({ address: proposalAddr as `0x${string}`, abi: FutarchyProposalAbi, functionName: 'collateralToken2' }).catch(() => null)
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
                }) as any;

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

    // Classify pool type
    const { type, isInverted, outcomeSide } = classifyPool(wt0.role || '', wt1.role || '');

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
    const proposalId = prop0 || prop1;
    if (!proposalId) {
        // No proposal linked — skip
        return;
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
    const price = convertSqrtPriceX96(sqrtPriceX96);
    // Invert price if needed
    const finalPrice = pool.isInverted ? (price === 0 ? 0 : 1 / price) : price;
    const priceStr = finalPrice.toString();
    const timestamp = Number(block?.timestamp || Math.floor(Date.now() / 1000));
    const blockNum = Number(block?.number || 0);

    pool.sqrtPrice = sqrtPriceX96.toString();
    pool.price = priceStr;
    pool.tick = tick;
    await pool.save();

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

    const price = convertSqrtPriceX96(sqrtPriceX96);
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
    if (swapsSinceFlush >= CANDLE_FLUSH_INTERVAL) {
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
