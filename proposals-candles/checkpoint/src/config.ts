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
import { rpcConfig } from './rpc-loader';

// ============================================================================
// Gnosis Chain Configuration (Algebra DEX)
// ============================================================================
export const gnosisConfig: CheckpointConfig = {
    // Free RPCs (rpc.gnosischain.com) have low block range limits (~500).
    // For production, use a paid RPC like QuickNode (supports 10k range).
    network_node_url: rpcConfig.gnosis_rpc,
    chunk_size: 10000, // Max eth_getLogs block range per request (QuickNode paid = 10k)

    sources: [
        // Futarchy Factory - emits NewProposal when proposals created
        {
            contract: '0xa6cB18FCDC17a2B44E5cAd2d80a6D5942d30a345',
            abi: 'FutarchyFactory',
            start: 40620030,
            events: [
                { name: 'NewProposal(address,string,bytes32,bytes32)', fn: 'handleNewProposal' }
            ]
        },
        // Algebra Factory - emits Pool when pools created
        {
            contract: '0xa0864cca6e114013ab0e27cbd5b6f4c8947da766',
            abi: 'AlgebraFactory',
            start: 40620030,
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
                { name: 'Swap(address,address,int256,int256,uint160,uint128,int24)', fn: 'handleSwap' }
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
    // Free RPCs (eth.llamarpc.com) have ~1k block range limits.
    // For production, use Infura/Alchemy (supports 50k+ range).
    network_node_url: rpcConfig.mainnet_rpc,
    chunk_size: 50000, // Max eth_getLogs block range per request (Infura paid = 50k+)

    sources: [
        // Futarchy Factory
        {
            contract: '0xf9369c0F7a84CAC3b7Ef78c837cF7313309D3678',
            abi: 'FutarchyFactory',
            start: 23419000,  // Just before first proposal at 23419797
            events: [
                { name: 'NewProposal(address,string,bytes32,bytes32)', fn: 'handleNewProposal' }
            ]
        },
        // Uniswap V3 Factory
        {
            contract: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            abi: 'UniswapV3Factory',
            start: 23419000,  // Match Futarchy factory start
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
                { name: 'Swap(address,address,int256,int256,uint160,uint128,int24)', fn: 'handleSwap' }
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
// Future Chain Configs (Template)
// ============================================================================
// export const arbitrumConfig: CheckpointConfig = {
//   network_node_url: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
//   sources: [...],
//   templates: { BalancerPool: {...} },
//   abis: { BalancerVault: BalancerVaultAbi, ... }
// };
