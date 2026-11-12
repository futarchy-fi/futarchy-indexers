// DEX Adapters - Isolated patterns for each DEX type
// Each adapter handles DEX-specific event parsing and normalization

import { ethers } from 'ethers';

// Chain ID mapping
export const CHAIN_IDS: Record<string, number> = {
    gnosis: 100,
    mainnet: 1,
    robinhood: 4663
};

// Indexer name for a chain-prefixed entity id such as "4663-0xabc…".
export function indexerForId(id: string): string {
    for (const [name, chainId] of Object.entries(CHAIN_IDS)) {
        if (id.startsWith(`${chainId}-`)) return name;
    }
    return 'gnosis';
}

/**
 * Extract indexer name from Checkpoint's source parameter
 * The source can be a string or an object - normalize to string
 */
export function getSourceName(source: any): string {
    if (typeof source === 'string') return source;

    // Checkpoint source object - check for indexer property first (used by template events)
    if (typeof source === 'object' && source !== null) {
        // Template events include 'indexer' property directly
        if (source.indexer && typeof source.indexer === 'string') {
            return source.indexer;
        }

        // Fall back to contract-based detection for factory events
        const contract = (source.contract as string)?.toLowerCase();

        // Mainnet contracts
        if (contract === '0xf9369c0f7a84cac3b7ef78c837cf7313309d3678' ||  // Mainnet Futarchy Factory
            contract === '0x1f98431c8ad98523631ae4a59f267346ea31f984') {   // Mainnet Uniswap V3 Factory
            return 'mainnet';
        }

        // Robinhood Chain contracts
        if (contract === '0x9b93fdcc9380a7e3df4978d856eaca4f7ee36fa2' ||  // Robinhood Futarchy Factory (Safe arbitrator)
            contract === '0xebb2bf1cbdd625a8118b720877a7e361696e7a14' ||  // Robinhood Futarchy Factory (first)
            contract === '0x1f7d7550b1b028f7571e69a784071f0205fd2efa') {   // Robinhood Uniswap V3 Factory
            return 'robinhood';
        }

        // Gnosis contracts
        if (contract === '0xa6cb18fcdc17a2b44e5cad2d80a6d5942d30a345' ||  // Gnosis Futarchy Factory
            contract === '0xa0864cca6e114013ab0e27cbd5b6f4c8947da766') {   // Gnosis Algebra Factory
            return 'gnosis';
        }
    }

    // Default to gnosis for backwards compatibility
    return 'gnosis';
}

// DEX types
export type DexType = 'ALGEBRA' | 'UNISWAP_V3' | 'BALANCER'; // Extensible

// Token roles
export const ROLE_YES_COMPANY = 'YES_COMPANY';
export const ROLE_NO_COMPANY = 'NO_COMPANY';
export const ROLE_YES_CURRENCY = 'YES_CURRENCY';
export const ROLE_NO_CURRENCY = 'NO_CURRENCY';
export const ROLE_COLLATERAL = 'COLLATERAL';
export const ROLE_COMPANY = 'COMPANY';

// Pool types
export const TYPE_EXPECTED_VALUE = 'EXPECTED_VALUE';
export const TYPE_PREDICTION = 'PREDICTION';
export const TYPE_CONDITIONAL = 'CONDITIONAL';
export const TYPE_UNKNOWN = 'UNKNOWN';

// Candle periods (seconds)
// Configurable via CANDLE_PERIODS env var (comma-separated seconds)
// Default: 3600 (1h only) for fast indexing
// Full set: CANDLE_PERIODS=60,300,900,3600,14400,86400
export const CANDLE_PERIODS: number[] = (process.env.CANDLE_PERIODS || '3600')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

/**
 * Normalize sqrtPriceX96 to decimal price
 */
export function convertSqrtPriceX96(sqrtPriceX96: bigint): number {
    const Q96 = BigInt(2) ** BigInt(96);
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    return sqrtPrice * sqrtPrice;
}

// PRICE_DECIMALS_ADJUST=true scales pool prices by the two tokens' decimals
// (token1 per token0 in whole-token units). Needed where the two sides
// differ, e.g. NVDA (18) / USDG (6) on Robinhood Chain. Off by default so the
// existing Gnosis and mainnet deployments keep producing the same numbers.
export const PRICE_DECIMALS_ADJUST = process.env.PRICE_DECIMALS_ADJUST === 'true';

export function poolPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
    const raw = convertSqrtPriceX96(sqrtPriceX96);
    return PRICE_DECIMALS_ADJUST ? adjustPriceForDecimals(raw, decimals0, decimals1) : raw;
}

/**
 * Adjust price for token decimals
 */
export function adjustPriceForDecimals(
    rawPrice: number,
    decimals0: number,
    decimals1: number
): number {
    const decimalAdjust = Math.pow(10, decimals0) / Math.pow(10, decimals1);
    return rawPrice * decimalAdjust;
}

/**
 * Determine pool type based on token roles
 */
export function classifyPool(role0: string, role1: string): {
    type: string;
    isInverted: boolean;
    outcomeSide: string | null;
} {
    let type = TYPE_UNKNOWN;
    let isInverted = false;
    let outcomeSide: string | null = null;

    // Rule 1: Collateral is always Quote
    if (role0 === ROLE_COLLATERAL && role1 !== ROLE_COLLATERAL) {
        isInverted = true;
        if (role1 === ROLE_YES_COMPANY || role1 === ROLE_NO_COMPANY) {
            type = TYPE_EXPECTED_VALUE;
        } else if (role1 === ROLE_YES_CURRENCY || role1 === ROLE_NO_CURRENCY) {
            type = TYPE_PREDICTION;
        }
    } else if (role1 === ROLE_COLLATERAL) {
        isInverted = false;
        if (role0 === ROLE_YES_COMPANY || role0 === ROLE_NO_COMPANY) {
            type = TYPE_EXPECTED_VALUE;
        } else if (role0 === ROLE_YES_CURRENCY || role0 === ROLE_NO_CURRENCY) {
            type = TYPE_PREDICTION;
        }
    }
    // Rule 2: Conditional pools (Company vs Currency Outcome)
    else if (
        (role0 === ROLE_YES_CURRENCY || role0 === ROLE_NO_CURRENCY) &&
        (role1 === ROLE_YES_COMPANY || role1 === ROLE_NO_COMPANY)
    ) {
        isInverted = true;
        type = TYPE_CONDITIONAL;
    } else if (
        (role1 === ROLE_YES_CURRENCY || role1 === ROLE_NO_CURRENCY) &&
        (role0 === ROLE_YES_COMPANY || role0 === ROLE_NO_COMPANY)
    ) {
        isInverted = false;
        type = TYPE_CONDITIONAL;
    }

    // Determine outcome side
    if (
        role0 === ROLE_YES_COMPANY || role0 === ROLE_YES_CURRENCY ||
        role1 === ROLE_YES_COMPANY || role1 === ROLE_YES_CURRENCY
    ) {
        outcomeSide = 'YES';
    } else if (
        role0 === ROLE_NO_COMPANY || role0 === ROLE_NO_CURRENCY ||
        role1 === ROLE_NO_COMPANY || role1 === ROLE_NO_CURRENCY
    ) {
        outcomeSide = 'NO';
    }

    return { type, isInverted, outcomeSide };
}

/**
 * Format pool name from symbols
 */
export function formatPoolName(
    symbol0: string,
    symbol1: string,
    isInverted: boolean
): string {
    return isInverted ? `${symbol1} / ${symbol0}` : `${symbol0} / ${symbol1}`;
}

/**
 * Create entity ID with chain prefix
 */
export function createId(chainId: number, address: string): string {
    return `${chainId}-${address.toLowerCase()}`;
}
