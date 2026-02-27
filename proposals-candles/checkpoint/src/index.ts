// Multichain Checkpoint Candles Indexer
// Entry point that registers both Gnosis and Mainnet indexers

import Checkpoint, { evm, LogLevel } from '@snapshot-labs/checkpoint';
import express, { Request, Response } from 'express';
import * as writers from './writers';
import { gnosisConfig, mainnetConfig } from './config';
import * as fs from 'fs';
import * as path from 'path';

// Load schema - works from both src/ (dev) and dist/ (prod)
// When running from dist/, __dirname is /app/dist, so we go up to find src/schema.gql
const schemaPath = path.resolve(__dirname, '..', 'src', 'schema.gql');
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

// Initialize Checkpoint with unified schema
const checkpoint = new Checkpoint(schema, {
    dbConnection: process.env.DATABASE_URL,
    logLevel: LogLevel.Info,
    prettifyLogs: process.env.NODE_ENV !== 'production',
    resetOnConfigChange: false  // NEVER auto-reset — preserves sync progress across restarts
});

// ============================================================================
// Register Multi-Chain Indexers
// ============================================================================

// Gnosis Chain (Algebra DEX)
console.log('Registering Gnosis indexer (Algebra DEX)...');
checkpoint.addIndexer('gnosis', gnosisConfig, new evm.EvmIndexer(writers));

// Ethereum Mainnet (Uniswap V3 DEX)
console.log('Registering Mainnet indexer (Uniswap V3 DEX)...');
checkpoint.addIndexer('mainnet', mainnetConfig, new evm.EvmIndexer(writers));

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

// ============================================================================
// API Endpoints
// ============================================================================

// GraphQL endpoint
app.use('/graphql', checkpoint.graphql);

// Health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: 'ok',
        chains: ['gnosis', 'mainnet'],
        timestamp: new Date().toISOString()
    });
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
        console.log('Resetting database...');
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
    // ⚠️  IMPORTANT: Do NOT call checkpoint.reset() here!
    // reset() wipes all sync progress from PostgreSQL.
    // Only use RESET=true env var for explicit full re-index.
    console.log(`Sync started at: ${syncStartTime.toISOString()}`);
    console.log('Starting checkpoint indexers (resuming from last block)...');
    checkpoint.start().catch(err => {
        console.error('Checkpoint indexer error:', err);
    });

    // Apply unique indexes after tables are created (5s delay for table creation)
    setTimeout(async () => {
        try {
            const { Client } = require('pg');
            const client = new Client({ connectionString: process.env.DATABASE_URL });
            await client.connect();

            const tables = ['pools', 'proposals', 'whitelistedtokens', 'candles', 'swaps'];
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
