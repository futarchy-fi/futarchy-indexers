import 'dotenv/config';
import express from 'express';
import Checkpoint, { evm } from '@snapshot-labs/checkpoint';
import { config } from './config';
import { writers } from './writers';
import { readFileSync } from 'fs';
import { join } from 'path';

const INDEXER_NAME = 'gnosis';
const DEFAULT_TEMPLATE_REWIND_BLOCKS = 1_000_000;

// Load schema
const schema = readFileSync(join(__dirname, 'schema.gql'), 'utf8');

// Initialize Checkpoint
const checkpoint = new Checkpoint(schema, {
    logLevel: 'info' as any,
    prettifyLogs: true
});

// Create EVM indexer with our writers
const evmIndexer = new evm.EvmIndexer(writers);

// Add the Gnosis Chain indexer
checkpoint.addIndexer(INDEXER_NAME, config, evmIndexer);

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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    if (!value) return fallback;

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function templateKey(template: string, contractAddress: string): string {
    return `${template}:${contractAddress.toLowerCase()}`;
}

async function loadCurrentEntityRows(knex: any, tableName: string, blockColumn: string) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) return [];

    const hasBlockRange = await knex.schema.hasColumn(tableName, 'block_range');
    const query = knex
        .select('id', blockColumn)
        .from(tableName)
        .where('_indexer', INDEXER_NAME);

    if (hasBlockRange) {
        query.andWhereRaw('upper_inf(block_range)');
    }

    return query;
}

async function rehydrateTemplateSources(): Promise<void> {
    const checkpointAny = checkpoint as any;
    const knex = checkpointAny.knex;
    const store = checkpointAny.store;

    if (!knex || !store) {
        console.warn('Template source rehydration skipped: checkpoint internals unavailable');
        return;
    }

    await store.createStore();

    const [organizations, proposals, existingSources] = await Promise.all([
        loadCurrentEntityRows(knex, 'organizations', 'createdAt'),
        loadCurrentEntityRows(knex, 'proposalentities', 'createdAtTimestamp'),
        knex
            .select('contract_address', 'template')
            .from('_template_sources')
            .where('indexer', INDEXER_NAME)
    ]);

    const existingKeys = new Set(
        existingSources.map((source: any) => templateKey(source.template, source.contract_address))
    );

    const seenCandidateKeys = new Set(existingKeys);
    const candidates = [
        ...organizations.map((organization: any) => ({
            contract_address: String(organization.id).toLowerCase(),
            start_block: Number(organization.createdAt),
            template: 'Organization'
        })),
        ...proposals.map((proposal: any) => ({
            contract_address: String(proposal.id).toLowerCase(),
            start_block: Number(proposal.createdAtTimestamp),
            template: 'ProposalMetadata'
        }))
    ].filter(source => {
        const key = templateKey(source.template, source.contract_address);
        if (
            !source.contract_address
            || !Number.isFinite(source.start_block)
            || source.start_block <= 0
            || seenCandidateKeys.has(key)
        ) {
            return false;
        }

        seenCandidateKeys.add(key);
        return true;
    });

    if (candidates.length === 0) {
        console.log('Template source rehydration: no missing template sources');
        return;
    }

    await knex('_template_sources').insert(
        candidates.map(source => ({
            indexer: INDEXER_NAME,
            contract_address: source.contract_address,
            start_block: source.start_block,
            template: source.template
        }))
    );

    console.log(`Template source rehydration: restored ${candidates.length} missing template sources`);

    const rewindBlocks = parsePositiveInteger(
        process.env.REGISTRY_TEMPLATE_REWIND_BLOCKS,
        DEFAULT_TEMPLATE_REWIND_BLOCKS
    );
    if (rewindBlocks === 0) return;

    const lastIndexedRow = await knex
        .select('value')
        .from('_metadatas')
        .where({ indexer: INDEXER_NAME, id: 'last_indexed_block' })
        .first();

    const lastIndexedBlock = lastIndexedRow ? Number.parseInt(lastIndexedRow.value, 10) : null;
    if (!lastIndexedBlock || !Number.isFinite(lastIndexedBlock)) return;

    const earliestRestoredStart = Math.min(...candidates.map(source => source.start_block));
    const rewindTarget = Math.max(earliestRestoredStart, lastIndexedBlock - rewindBlocks);

    if (rewindTarget >= lastIndexedBlock) return;

    await store.removeFutureData(INDEXER_NAME, rewindTarget);
    console.log(
        `Template source rehydration: rewound ${INDEXER_NAME} from block ${lastIndexedBlock} to ${rewindTarget}`
    );
}

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

        await rehydrateTemplateSources();

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
