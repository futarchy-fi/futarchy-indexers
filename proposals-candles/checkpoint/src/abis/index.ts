// ABI Exports - All ABIs in one place
// Pattern: Each DEX/protocol has its own file for isolation

// Futarchy Protocol
export { FutarchyFactoryAbi } from './futarchyFactory';
export { FutarchyProposalAbi } from './futarchyProposal';
export { FutarchyMultiFactoryAbi } from './futarchyMultiFactory';
export { FutarchyMultiProposalAbi } from './futarchyMultiProposal';

// Common
export { ERC20Abi } from './erc20';

// DEX: Algebra (Gnosis Chain)
export { AlgebraFactoryAbi } from './algebraFactory';
export { AlgebraPoolAbi } from './algebraPool';

// DEX: Uniswap V3 (Ethereum Mainnet)
export { UniswapV3FactoryAbi } from './uniswapV3Factory';
export { UniswapV3PoolAbi } from './uniswapV3Pool';

// Future DEXs can be added here:
// export { BalancerVaultAbi } from './balancerVault';
// export { CurvePoolAbi } from './curvePool';
