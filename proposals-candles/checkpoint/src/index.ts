// Multichain Checkpoint Candles Indexer
// Entry point that registers both Gnosis and Mainnet indexers

import Checkpoint, { evm, LogLevel } from '@snapshot-labs/checkpoint';
import express, { Request, Response } from 'express';
import * as writers from './writers';
import { enabledIndexers } from './config';
import * as fs from 'fs';
import * as path from 'path';

// Load schema from dev or compiled layouts.
const schemaPath = [
    path.resolve(__dirname, '..', 'src', 'schema.gql'),
    path.resolve(__dirname, '..', '..', 'src', 'schema.gql'),
    path.resolve(__dirname, 'schema.gql')
].find(candidate => fs.existsSync(candidate));
if (!schemaPath) {
    throw new Error('Could not find src/schema.gql');
}
const schema = fs.readFileSync(schemaPath, 'utf8');

const app = express();

// CORS - allow all origins for local development
app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
});

app.use(express.json());

// Serve static files (index.html chart viewer)
const staticDir = path.resolve(__dirname, '..');
app.use(express.static(staticDir));

function getCheckpointLogLevel(): LogLevel {
    switch ((process.env.CHECKPOINT_LOG_LEVEL || '').toLowerCase()) {
        case 'silent':
            return LogLevel.Silent;
        case 'fatal':
            return LogLevel.Fatal;
        case 'error':
            return LogLevel.Error;
        case 'warn':
            return LogLevel.Warn;
        case 'debug':
            return LogLevel.Debug;
        case 'info':
        default:
            return LogLevel.Info;
    }
}

// Initialize Checkpoint with unified schema
const checkpoint = new Checkpoint(schema, {
    dbConnection: process.env.DATABASE_URL,
    logLevel: getCheckpointLogLevel(),
    prettifyLogs: process.env.NODE_ENV !== 'production',
    // Production data must survive deploys. Config/schema changes should not
    // silently wipe a multi-hour historical index; use RESET=true with the
    // explicit confirmation token below when a clean rebuild is intentional.
    resetOnConfigChange: false
});

const RESET_CONFIRMATION = 'wipe-candles-db';

const REQUIRED_GNOSIS_PROPOSALS = [
    '0x2c1e08674f3f78f8a1426a41c41b8bf546fa481a', // KIP-81
    '0x45e1064348fd8a407d6d1f59fc64b05f633b28fc', // GIP-145
    '0xb607bd7c7201e966e6a150cd6ef1d08db55cad5d', // KIP-86
    '0x47c80f5f701ebc5f25cab64e660f0577890729c2', // GIP-149
    '0x0cae5e6f520e52e3d6a93c856bb6dbf7781f2e31', // KIP-88
];

const REQUIRED_CONDITIONAL_POOLS = [
    '100-0x36d46321ca07e822a6b71e31046dbb4a6f09e415', // KIP-81 YES
    '100-0x462bb6bb0261b2159b0e3cc763a1499e29afc1f8', // KIP-81 NO
    '100-0xf8346e622557763a62cc981187d084695ee296c3', // GIP-145 YES
    '100-0x76f78ec457c1b14bcf972f16eae44c7aa21d578f', // GIP-145 NO
    '100-0xb4f95f99ff661b26f13a6f6d61bb535e61df783f', // KIP-88 YES
    '100-0x951d458bf87c4fc404ed87da83e737dc829fe950', // KIP-88 NO
];

const REQUIRED_CANDLE_POOLS = [
    '100-0x36d46321ca07e822a6b71e31046dbb4a6f09e415',
    '100-0xf8346e622557763a62cc981187d084695ee296c3',
    '100-0x76f78ec457c1b14bcf972f16eae44c7aa21d578f',
    '100-0xb4f95f99ff661b26f13a6f6d61bb535e61df783f',
];

type CoverageStatus = {
    ok: boolean;
    checkedAt: string;
    counts?: Record<string, number>;
    missing: {
        proposals: string[];
        conditionalPools: string[];
        candlePools: string[];
    };
    error?: string;
};

// ============================================================================
// Register Multi-Chain Indexers
// ============================================================================

// Gnosis Chain (Algebra DEX) / Ethereum Mainnet (Uniswap V3 DEX).
// DISABLE_GNOSIS=true / DISABLE_MAINNET=true skip registration (see config.ts).
const indexers = enabledIndexers();
for (const [name, config] of Object.entries(indexers)) {
    console.log(`Registering ${name} indexer...`);
    checkpoint.addIndexer(name, config, new evm.EvmIndexer(writers));
}

// Future chains can be added here:
// checkpoint.addIndexer('arbitrum', arbitrumConfig, new evm.EvmIndexer(writers));

// ============================================================================
// Suppress benign tip-polling errors
// When at chain tip, checkpoint repeatedly tries to fetch future blocks,
// producing BlockNotFoundError spam. These are harmless and just noise.
// ============================================================================
const originalConsoleError = console.error;
const suppressedPatterns = ['BlockNotFoundError', 'Block at number', 'reorg detected'];
console.error = (...args: any[]) => {
    const msg = args.map(String).join(' ');
    if (suppressedPatterns.some(p => msg.includes(p))) return;
    originalConsoleError.apply(console, args);
};

function normalizeAddress(value: string): string {
    return value.toLowerCase();
}

function missingFrom(required: string[], found: string[]): string[] {
    const foundSet = new Set(found.map(normalizeAddress));
    return required.filter(item => !foundSet.has(normalizeAddress(item)));
}

async function runCoverageCheck(): Promise<CoverageStatus> {
    const checkedAt = new Date().toISOString();
    const emptyMissing = { proposals: [], conditionalPools: [], candlePools: [] };

    if (process.env.COVERAGE_CHECK === 'false') {
        return { ok: true, checkedAt, missing: emptyMissing };
    }

    // Coverage targets are Gnosis-specific; a mainnet-only instance
    // (DISABLE_GNOSIS=true) has none of them by design.
    if (!indexers.gnosis) {
        return { ok: true, checkedAt, missing: emptyMissing };
    }

    if (!process.env.DATABASE_URL) {
        return {
            ok: false,
            checkedAt,
            missing: emptyMissing,
            error: 'DATABASE_URL is not set'
        };
    }

    const { Client } = require('pg');
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000
    });

    try {
        await client.connect();

        const [countsResult, proposalsResult, poolsResult, candlePoolsResult] = await Promise.all([
            client.query(`
                SELECT 'proposals' AS table_name, count(*)::int AS count FROM proposals
                UNION ALL SELECT 'pools', count(*)::int FROM pools
                UNION ALL SELECT 'candles', count(*)::int FROM candles
                UNION ALL SELECT 'swaps', count(*)::int FROM swaps
            `),
            client.query(
                'SELECT lower(address) AS address FROM proposals WHERE chain = 100 AND lower(address) = ANY($1::text[])',
                [REQUIRED_GNOSIS_PROPOSALS.map(normalizeAddress)]
            ),
            client.query(
                'SELECT lower(id) AS id FROM pools WHERE lower(id) = ANY($1::text[]) AND type = $2',
                [REQUIRED_CONDITIONAL_POOLS.map(normalizeAddress), 'CONDITIONAL']
            ),
            client.query(
                'SELECT DISTINCT lower(pool) AS pool FROM candles WHERE lower(pool) = ANY($1::text[]) AND period = $2',
                [REQUIRED_CANDLE_POOLS.map(normalizeAddress), 3600]
            )
        ]);

        const counts = Object.fromEntries(
            countsResult.rows.map((row: any) => [row.table_name, Number(row.count)])
        );
        const missing = {
            proposals: missingFrom(REQUIRED_GNOSIS_PROPOSALS, proposalsResult.rows.map((row: any) => row.address)),
            conditionalPools: missingFrom(REQUIRED_CONDITIONAL_POOLS, poolsResult.rows.map((row: any) => row.id)),
            candlePools: missingFrom(REQUIRED_CANDLE_POOLS, candlePoolsResult.rows.map((row: any) => row.pool))
        };

        const ok = missing.proposals.length === 0
            && missing.conditionalPools.length === 0
            && missing.candlePools.length === 0;

        return { ok, checkedAt, counts, missing };
    } catch (err: any) {
        return {
            ok: false,
            checkedAt,
            missing: emptyMissing,
            error: err?.message || String(err)
        };
    } finally {
        await client.end().catch(() => undefined);
    }
}

async function isCheckpointStoreInitialized(): Promise<boolean> {
    if (!process.env.DATABASE_URL) return false;

    const { Client } = require('pg');
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 2000,
        statement_timeout: 5000
    });

    try {
        await client.connect();
        const result = await client.query(
            "SELECT to_regclass('public._metadatas') IS NOT NULL AS initialized"
        );
        return result.rows[0]?.initialized === true;
    } finally {
        await client.end().catch(() => undefined);
    }
}

// ============================================================================
// API Endpoints
// ============================================================================

// GraphQL endpoint
app.use('/graphql', checkpoint.graphql);

// Health check
app.get('/health', async (_req: Request, res: Response) => {
    const coverage = await runCoverageCheck();
    res.status(coverage.ok ? 200 : 503).json({
        status: coverage.ok ? 'ok' : 'unhealthy',
        chains: Object.keys(indexers),
        timestamp: new Date().toISOString(),
        coverage
    });
});

app.get('/coverage', async (_req: Request, res: Response) => {
    const coverage = await runCoverageCheck();
    res.status(coverage.ok ? 200 : 503).json(coverage);
});

// Sync status — shows elapsed time since indexer started
const syncStartTime = new Date();
const syncStartFile = path.resolve(__dirname, '..', 'sync-start.txt');
fs.writeFileSync(syncStartFile, `Sync started: ${syncStartTime.toISOString()}\n`);

app.get('/sync-status', (_req: Request, res: Response) => {
    const elapsed = Date.now() - syncStartTime.getTime();
    const hours = Math.floor(elapsed / 3600000);
    const mins = Math.floor((elapsed % 3600000) / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    res.json({
        started: syncStartTime.toISOString(),
        elapsed: `${hours}h ${mins}m ${secs}s`,
        elapsedMs: elapsed
    });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;

async function start() {
    // Reset database if RESET=true
    if (process.env.RESET === 'true') {
        if (process.env.RESET_CONFIRM !== RESET_CONFIRMATION) {
            throw new Error(
                `RESET=true requires RESET_CONFIRM=${RESET_CONFIRMATION}. ` +
                'This prevents accidental production history wipes.'
            );
        }
        console.log('Resetting database...');
        await checkpoint.reset();
    } else if (!(await isCheckpointStoreInitialized())) {
        console.log('Initializing empty Checkpoint database...');
        await checkpoint.reset();
    }

    // Start HTTP server FIRST (so API is available during sync)
    app.listen(PORT, () => {
        console.log(`
╔════════════════════════════════════════════════════════════╗
║   Multichain Candles Indexer Running                       ║
╠════════════════════════════════════════════════════════════╣
║   GraphQL:  http://localhost:${PORT}/graphql                  ║
║   Health:   http://localhost:${PORT}/health                   ║
║   Sync:     http://localhost:${PORT}/sync-status              ║
╠════════════════════════════════════════════════════════════╣
║   Chains:   Gnosis (100) | Mainnet (1)                     ║
║   DEXs:     Algebra      | Uniswap V3                      ║
╚════════════════════════════════════════════════════════════╝
    `);
    });

    // Start indexers (non-blocking - runs in background)
    console.log(`Sync started at: ${syncStartTime.toISOString()}`);
    console.log('Starting checkpoint indexers...');
    checkpoint.start().catch(err => {
        console.error('Checkpoint indexer error:', err);
    });

    // Apply unique indexes after tables are created (5s delay for table creation)
    setTimeout(async () => {
        try {
            const { Client } = require('pg');
            const client = new Client({ connectionString: process.env.DATABASE_URL });
            await client.connect();

            const tables = [
                'pools', 'proposals', 'whitelistedtokens', 'candles', 'swaps',
                // Multi-option tables; absent on databases created before they existed.
                'multiproposals', 'proposaloptions', 'optiontokens'
            ];
            for (const tbl of tables) {
                try {
                    await client.query(`
                        CREATE UNIQUE INDEX IF NOT EXISTS idx_${tbl}_unique_active 
                        ON ${tbl} (id, _indexer) 
                        WHERE upper_inf(block_range)
                    `);
                    console.log(`✅ Unique index on ${tbl}`);
                } catch (e: any) {
                    // Table might not exist yet or index already exists
                    if (!e.message.includes('does not exist')) {
                        console.warn(`⚠️ Index on ${tbl}:`, e.message);
                    }
                }
            }

            await client.end();
            console.log('✅ Unique indexes applied');
        } catch (err) {
            console.warn('⚠️ Could not apply unique indexes:', err);
        }
    }, 5000);
}

start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
