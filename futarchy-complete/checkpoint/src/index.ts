import 'dotenv/config';
import express from 'express';
import Checkpoint, { evm } from '@snapshot-labs/checkpoint';
import { config } from './config';
import { writers } from './writers';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load schema
const schema = readFileSync(join(__dirname, 'schema.gql'), 'utf8');

// Initialize Checkpoint
const checkpoint = new Checkpoint(schema, {
    logLevel: 'info' as any,
    prettifyLogs: true,
    resetOnConfigChange: true
});

// Create EVM indexer with our writers
const evmIndexer = new evm.EvmIndexer(writers);

// Add the Gnosis Chain indexer
checkpoint.addIndexer('gnosis', config, evmIndexer);

// Express app for GraphQL API
const app = express();
const PORT = process.env.PORT || 3000;

// CORS - allow all origins for local development
app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
});

// GraphQL endpoint
app.use('/graphql', checkpoint.graphql);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// Start indexer with retry logic
async function startIndexerWithRetry(maxRetries = 100) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📊 Starting indexer (attempt ${attempt})...`);
            await checkpoint.start();
            return; // Success
        } catch (error: any) {
            const isBlockNotFound = error?.name === 'BlockNotFoundError' ||
                error?.message?.includes('Block') ||
                error?.message?.includes('not be found');

            if (isBlockNotFound && attempt < maxRetries) {
                console.log(`⏳ Block not found, waiting 5s and retrying... (${attempt}/${maxRetries})`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                throw error;
            }
        }
    }
}

// Start server and indexer
async function main() {
    try {
        console.log('🚀 Futarchy Checkpoint Indexer');
        console.log('─────────────────────────────');

        // Reset and create tables (only on first run or schema change)
        if (process.env.RESET === 'true') {
            console.log('🔄 Resetting database...');
            await checkpoint.reset();
        }

        // Start the GraphQL server first
        app.listen(PORT, () => {
            console.log(`\n🌐 GraphQL API: http://localhost:${PORT}/graphql`);
            console.log(`❤️  Health:      http://localhost:${PORT}/health`);
        });

        // Start the indexer with retry logic
        await startIndexerWithRetry();

    } catch (error) {
        console.error('❌ Failed to start:', error);
        process.exit(1);
    }
}

main();
