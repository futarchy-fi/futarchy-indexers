// Configuration for multichain Checkpoint indexer
// Each chain has its own config with DEX-specific event mappings

import { CheckpointConfig } from '@snapshot-labs/checkpoint';
import {
    FutarchyFactoryAbi,
    FutarchyProposalAbi,
    AlgebraFactoryAbi,
    AlgebraPoolAbi,
    UniswapV3FactoryAbi,
    UniswapV3PoolAbi,
    ERC20Abi
} from './abis';

const GNOSIS_START_BLOCK = parseInt(process.env.GNOSIS_START_BLOCK || '40620030', 10);
const MAINNET_START_BLOCK = parseInt(process.env.MAINNET_START_BLOCK || '23419000', 10);
// Robinhood Chain (4663): the FutarchyFactory was deployed at block 112,079,593.
const ROBINHOOD_START_BLOCK = parseInt(process.env.ROBINHOOD_START_BLOCK || '112079000', 10);

// ============================================================================
// Gnosis Chain Configuration (Algebra DEX)
// ============================================================================
export const gnosisConfig: CheckpointConfig = {
    // Free RPCs (rpc.gnosischain.com) have low block range limits.
    // The actual eth_getLogs split size is controlled by the Checkpoint
    // provider patch via CHECKPOINT_MAX_BLOCKS_PER_REQUEST.
    network_node_url: process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com',

    sources: [
        // Futarchy Factory - emits NewProposal when proposals created
        {
            contract: '0xa6cB18FCDC17a2B44E5cAd2d80a6D5942d30a345',
            abi: 'FutarchyFactory',
            start: GNOSIS_START_BLOCK,
            events: [
                { name: 'NewProposal(address,string,bytes32,bytes32)', fn: 'handleNewProposal' }
            ]
        },
        // Algebra Factory - emits Pool when pools created
        {
            contract: '0xa0864cca6e114013ab0e27cbd5b6f4c8947da766',
            abi: 'AlgebraFactory',
            start: GNOSIS_START_BLOCK,
            events: [
                { name: 'Pool(address,address,address)', fn: 'handleAlgebraPoolCreated' }
            ]
        }
    ],

    // Dynamic pool tracking
    templates: {
        AlgebraPool: {
            abi: 'AlgebraPool',
            events: [
                { name: 'Initialize(uint160,int24)', fn: 'handleInitialize' },
                { name: 'Swap(address,address,int256,int256,uint160,uint128,int24)', fn: 'handleSwap' },
                // Mint/Burn keep pool.liquidity correct when LPs add/remove
                // liquidity WITHOUT a following swap. These were dropped in
                // 2a914e8 ("RPC optimizations"), which made liquidity-adds
                // invisible until the next swap (e.g. KIP-88's YES pool showed
                // stale seed liquidity). handleMint/handleBurn already exist.
                { name: 'Mint(address,address,int24,int24,uint128,uint256,uint256)', fn: 'handleMint' },
                { name: 'Burn(address,int24,int24,uint128,uint256,uint256)', fn: 'handleBurn' }
            ]
        }
    },

    abis: {
        FutarchyFactory: FutarchyFactoryAbi,
        FutarchyProposal: FutarchyProposalAbi,
        AlgebraFactory: AlgebraFactoryAbi,
        AlgebraPool: AlgebraPoolAbi,
        ERC20: ERC20Abi
    }
};

// ============================================================================
// Ethereum Mainnet Configuration (Uniswap V3 DEX)
// ============================================================================
export const mainnetConfig: CheckpointConfig = {
    // Free RPCs (eth.llamarpc.com) have low block range limits.
    // The actual eth_getLogs split size is controlled by the Checkpoint
    // provider patch via CHECKPOINT_MAX_BLOCKS_PER_REQUEST.
    network_node_url: process.env.MAINNET_RPC_URL || 'https://eth.llamarpc.com',

    sources: [
        // Futarchy Factory
        {
            contract: '0xf9369c0F7a84CAC3b7Ef78c837cF7313309D3678',
            abi: 'FutarchyFactory',
            start: MAINNET_START_BLOCK,  // Default is just before first proposal at 23419797
            events: [
                { name: 'NewProposal(address,string,bytes32,bytes32)', fn: 'handleNewProposal' }
            ]
        },
        // Uniswap V3 Factory
        {
            contract: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            abi: 'UniswapV3Factory',
            start: MAINNET_START_BLOCK,  // Match Futarchy factory start
            events: [
                { name: 'PoolCreated(address,address,uint24,int24,address)', fn: 'handleUniswapPoolCreated' }
            ]
        }
    ],

    // Dynamic pool tracking
    templates: {
        UniswapV3Pool: {
            abi: 'UniswapV3Pool',
            events: [
                { name: 'Initialize(uint160,int24)', fn: 'handleInitialize' },
                { name: 'Swap(address,address,int256,int256,uint160,uint128,int24)', fn: 'handleSwap' },
                // See Gnosis/AlgebraPool above — re-added after 2a914e8 dropped them.
                { name: 'Mint(address,address,int24,int24,uint128,uint256,uint256)', fn: 'handleMint' },
                { name: 'Burn(address,int24,int24,uint128,uint256,uint256)', fn: 'handleBurn' }
            ]
        }
    },

    abis: {
        FutarchyFactory: FutarchyFactoryAbi,
        FutarchyProposal: FutarchyProposalAbi,
        UniswapV3Factory: UniswapV3FactoryAbi,
        UniswapV3Pool: UniswapV3PoolAbi,
        ERC20: ERC20Abi
    }
};

// ============================================================================
// Robinhood Chain Configuration (chainId 4663, Uniswap V3 DEX)
// ============================================================================
export const robinhoodConfig: CheckpointConfig = {
    // The public RPC caps eth_getLogs at 100,000 blocks; keep
    // ROBINHOOD_BLOCK_RANGE at 50,000 or below.
    network_node_url: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',

    sources: [
        // Futarchy Factory
        {
            contract: '0xEBB2Bf1cbDd625A8118b720877a7E361696E7a14',
            abi: 'FutarchyFactory',
            start: ROBINHOOD_START_BLOCK,
            events: [
                { name: 'NewProposal(address,string,bytes32,bytes32)', fn: 'handleNewProposal' }
            ]
        },
        // Uniswap V3 Factory (not the canonical address on this chain)
        {
            contract: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
            abi: 'UniswapV3Factory',
            start: ROBINHOOD_START_BLOCK,
            events: [
                { name: 'PoolCreated(address,address,uint24,int24,address)', fn: 'handleUniswapPoolCreated' }
            ]
        }
    ],

    templates: mainnetConfig.templates,
    abis: mainnetConfig.abis
};

// ============================================================================
// Indexer selection
// ============================================================================
// DISABLE_GNOSIS=true / DISABLE_MAINNET=true drop the corresponding indexer.
// This allows a second, isolated deployment to run mainnet-only against its
// own fresh postgres (see docker-compose.mainnet.yml): checkpoint's
// per-indexer schema_version guard rejects a NEW indexer name on an
// already-initialized database ("schema changed — schema version changed from
// null to 1"), so mainnet cannot simply be flipped on against the Gnosis prod
// database without a reset.
export function enabledIndexers(env: NodeJS.ProcessEnv = process.env): Record<string, CheckpointConfig> {
    const indexers: Record<string, CheckpointConfig> = {};
    if (env.DISABLE_GNOSIS !== 'true') indexers.gnosis = gnosisConfig;
    if (env.DISABLE_MAINNET !== 'true') indexers.mainnet = mainnetConfig;
    // Opt-in, so the existing Gnosis and mainnet deployments never see a new
    // indexer name on their databases (see the schema_version note above).
    if (env.ENABLE_ROBINHOOD === 'true') indexers.robinhood = robinhoodConfig;
    return indexers;
}

// ============================================================================
// Future Chain Configs (Template)
// ============================================================================
// export const arbitrumConfig: CheckpointConfig = {
//   network_node_url: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
//   sources: [...],
//   templates: { BalancerPool: {...} },
//   abis: { BalancerVault: BalancerVaultAbi, ... }
// };
