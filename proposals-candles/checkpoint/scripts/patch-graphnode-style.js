/**
 * patch-graphnode-style.js
 * 
 * Single unified patch — mirrors Graph-Node's Rust indexing pipeline.
 * 
 * Graph-Node source refs:
 *   runner.rs       → process_block loop, transact_block_operations (batch DB)
 *   chain.rs        → scan_triggers (batch getLogs), load_blocks (cache-first)
 *   ethereum_adapter.rs → buffered(block_batch_size) parallel block fetch
 * 
 * Patches 5 files:
 *   provider.js     → block cache, batch getLogs, retry _getLogs, null parentHash
 *   container.js    → adaptive ranges, skip reorg, batch DB writes
 *   model.js        → delete-then-insert (handles exclusion constraints)
 *   helpers.js      → -32603 error code (range halving)
 *   checkpoints.js  → idempotent setBlockHash
 */

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..', 'node_modules', '@snapshot-labs', 'checkpoint', 'dist', 'src');

function patchFile(relPath, patches) {
    const filePath = path.join(BASE, relPath);
    let content = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(relPath);

    for (const { name, find, replace } of patches) {
        if (!content.includes(find)) {
            console.error(`  [FAIL] ${fileName}: ${name} — target string not found!`);
            console.error(`  Looking for: ${JSON.stringify(find.substring(0, 80))}...`);
            process.exit(1);
        }
        content = content.replace(find, replace);
        console.log(`  [OK]   ${fileName}: ${name}`);
    }

    fs.writeFileSync(filePath, content);
    console.log(`  ✓ ${fileName} saved\n`);
}

console.log('\n=== Graph-Node Style Patch ===\n');

// ============================================================
// 1. PROVIDER.JS — block cache, batch getLogs, retry, reorg guard
// ============================================================

patchFile('providers/evm/provider.js', [
    {
        name: '#1 Block cache + batch getLogs class header',
        find: 'class EvmProvider extends base_1.BaseProvider {\n    client;\n    writers;\n    sourceHashes = new Map();\n    logsCache = new Map();',
        replace: `// ===== GRAPH-NODE: block cache (fetch_unique_blocks_from_cache) =====
const blockCache = new Map();
const MAX_BLOCK_CACHE = 2000;
// TTL so a cached hash for a block that later reorgs cannot be served forever.
// Without this, the in-memory cache immortalises an orphaned hash and feeds the
// reorg detector the same bad value on every retry → infinite reorg loop.
const BLOCK_CACHE_TTL_MS = parseInt(process.env.BLOCK_CACHE_TTL_MS || '60000', 10);
function blockCacheGet(blockNumber) {
    const e = blockCache.get(blockNumber);
    if (!e) return null;
    if (BLOCK_CACHE_TTL_MS > 0 && (Date.now() - (e.at || 0)) > BLOCK_CACHE_TTL_MS) {
        blockCache.delete(blockNumber);
        return null;
    }
    return e;
}
function blockCacheSet(blockNumber, val) {
    if (blockCache.size > MAX_BLOCK_CACHE) {
        const oldest = blockCache.keys().next().value;
        blockCache.delete(oldest);
    }
    blockCache.set(blockNumber, { ...val, at: Date.now() });
}
// Exported so the container's reorg loop-breaker can flush a poisoned hash.
function clearBlockCache() { blockCache.clear(); }

// ===== GRAPH-NODE: per-URL rate limiter (request_semaphore in ethereum_adapter.rs) =====
const RPC_MIN_DELAY = parseInt(process.env.RPC_MIN_DELAY_MS || '25', 10);
const rpcLastCall = new Map();
async function rpcThrottle(url) {
    const last = rpcLastCall.get(url) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < RPC_MIN_DELAY) {
        await new Promise(r => setTimeout(r, RPC_MIN_DELAY - elapsed));
    }
    rpcLastCall.set(url, Date.now());
}

class EvmProvider extends base_1.BaseProvider {
    client;
    writers;
    sourceHashes = new Map();
    logsCache = new Map();`
    },
    {
        name: '#2 Cache getBlockHash (Graph-Node: ancestor_block DB cache)',
        find: `    async getBlockHash(blockNumber) {
        const block = await this.client.getBlock({
            blockNumber: BigInt(blockNumber)
        });
        return block.hash;
    }`,
        replace: `    // Loop-breaker hook: flush the in-memory block cache so the next read
    // re-fetches the canonical hash after a reorg.
    clearBlockCache() { clearBlockCache(); }
    async getBlockHash(blockNumber) {
        // Graph-Node: ancestor_block checks DB cache first, RPC fallback (TTL-bounded)
        const cached = blockCacheGet(blockNumber);
        if (cached) return cached.hash;
        const block = await this.client.getBlock({
            blockNumber: BigInt(blockNumber)
        });
        blockCacheSet(blockNumber, { hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp });
        return block.hash;
    }`
    },
    {
        name: '#3 Cache block in processBlock + null parentHash guard',
        find: `    async processBlock(blockNumber, parentHash) {
        let block = null;
        let eventsData;
        const skipBlockFetching = this.instance.opts?.skipBlockFetching ?? false;
        const hasPreloadedBlockEvents = skipBlockFetching && this.logsCache.has(BigInt(blockNumber));
        try {
            if (!hasPreloadedBlockEvents) {
                block = await this.client.getBlock({
                    blockNumber: BigInt(blockNumber)
                });
            }
        }
        catch (err) {
            this.log.error({ blockNumber, err }, 'getting block failed... retrying');
            throw err;
        }`,
        replace: `    async processBlock(blockNumber, parentHash) {
        let block = null;
        let eventsData;
        const skipBlockFetching = this.instance.opts?.skipBlockFetching ?? false;
        const hasPreloadedBlockEvents = skipBlockFetching && this.logsCache.has(BigInt(blockNumber));
        try {
            if (!hasPreloadedBlockEvents) {
                // Graph-Node: fetch_unique_blocks_from_cache — check memory cache first (TTL-bounded)
                const cached = blockCacheGet(blockNumber);
                if (cached) {
                    block = cached;
                } else {
                    block = await this.client.getBlock({
                        blockNumber: BigInt(blockNumber)
                    });
                    blockCacheSet(blockNumber, { hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp });
                }
            }
        }
        catch (err) {
            // Graph-Node: retry with backoff on 429/rate limits
            if (err.status === 429 || (err.message && err.message.includes('Too Many Requests'))) {
                const delay = 2000 + Math.random() * 3000;
                this.log.warn({ blockNumber, delayMs: Math.round(delay) }, '429 rate limited, backing off');
                await new Promise(r => setTimeout(r, delay));
            }
            this.log.error({ blockNumber, err: err.message || err }, 'getting block failed... retrying');
            throw err;
        }`
    },
    {
        name: '#4 Null parentHash guard (Graph-Node: Final blocks skip reorg)',
        find: '        if (block && parentHash && block.parentHash !== parentHash) {',
        replace: '        if (parentHash && block && block.parentHash && block.parentHash !== parentHash) {'
    },
    {
        name: '#5 Batch getLogs — chunkSize from env (Graph-Node: no chunk limit)',
        find: '        for (let i = 0; i < sources.length; i += 20) {',
        replace: `        const chunkSize = parseInt(process.env.CHECKPOINT_BATCH_SIZE || '200', 10);
        for (let i = 0; i < sources.length; i += chunkSize) {`
    },
    {
        name: '#6 Fix getLogsForSources slice to use chunkSize (was hardcoded 20)',
        find: '            chunks.push(sources.slice(i, i + 20));',
        replace: '            chunks.push(sources.slice(i, i + chunkSize));'
    },
    {
        name: '#7 Retry _getLogs in getEvents with exponential backoff',
        find: `            events = await this._getLogs({
                blockHash
            });`,
        replace: `            // Graph-Node: retry() with backoff on all RPC calls
            for (let _retry = 0; _retry < 5; _retry++) {
                try {
                    events = await this._getLogs({
                        blockHash
                    });
                    break;
                } catch (retryErr) {
                    if (_retry < 4) {
                        const backoff = Math.min(1000 * Math.pow(2, _retry), 10000);
                        this.log.warn({ blockNumber, err: retryErr.message, retry: _retry + 1, backoffMs: backoff }, 'getEvents _getLogs failed, retrying');
                        await new Promise(r => setTimeout(r, backoff));
                        continue;
                    }
                    throw retryErr;
                }
            }`
    },
    {
        name: '#8 Universal 429 retry in _getLogs (Graph-Node: request_semaphore)',
        find: `        const res = await fetch(this.instance.config.network_node_url, {
            method: 'POST',
            signal,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getLogs',
                params: [params]
            })
        });
        if (!res.ok) {
            throw new Error(\`Request failed: \${res.statusText}\`);
        }`,
        replace: `        // Graph-Node: retry with backoff for 429/5xx (request_semaphore + retry)
        let res;
        for (let _rpcRetry = 0; _rpcRetry < 5; _rpcRetry++) {
            await rpcThrottle(this.instance.config.network_node_url);
            res = await fetch(this.instance.config.network_node_url, {
                method: 'POST',
                signal,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'eth_getLogs',
                    params: [params]
                })
            });
            if (res.ok) break;
            if (res.status === 429 || res.status >= 500) {
                const delay = Math.min(2000 * Math.pow(2, _rpcRetry), 15000) + Math.random() * 1000;
                console.warn('[_getLogs] ' + res.status + ' rate limited, retry ' + (_rpcRetry+1) + '/5, backoff ' + Math.round(delay) + 'ms');
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw new Error(\`Request failed: \${res.statusText}\`);
        }
        if (!res.ok) {
            throw new Error(\`Request failed after 5 retries: \${res.statusText}\`);
        }`
    }
]);

// ============================================================
// 2. CONTAINER.JS — adaptive ranges, skip reorg, batch writes
// ============================================================

patchFile('container.js', [
    {
        name: '#1 Adaptive ranges (Graph-Node: target_triggers=100)',
        find: `const BLOCK_PRELOAD_START_RANGE = 1000;
const BLOCK_RELOAD_MIN_RANGE = 10;
const BLOCK_PRELOAD_STEP = 100;
const BLOCK_PRELOAD_TARGET = 10;`,
        replace: `// Graph-Node: target_triggers_per_block_range=100, max_block_range_size=5000
const BLOCK_PRELOAD_START_RANGE = 5000;
const BLOCK_RELOAD_MIN_RANGE = 100;
const BLOCK_PRELOAD_STEP = 500;
const BLOCK_PRELOAD_TARGET = 100;`
    },
    {
        name: '#2 Skip reorg + batch DB writes constants',
        find: 'const DEFAULT_FETCH_INTERVAL = 2000;',
        replace: `const DEFAULT_FETCH_INTERVAL = 2000;
// Graph-Node: BlockFinality::Final vs NonFinal — skip reorg when far behind
const SKIP_REORG_THRESHOLD = parseInt(process.env.SKIP_REORG_THRESHOLD || '1000', 10);
// Confirmation depth: never run the parentHash reorg check within this many
// blocks of the LIVE tip. Tip-edge upstreams briefly disagree on hashes there,
// producing false reorgs. K=200 >> typical Gnosis propagation spread (<~tens).
const REORG_CONFIRMATIONS = parseInt(process.env.REORG_CONFIRMATIONS || '200', 10);
// Loop-breaker: if the SAME block reorg-fails this many times in a row, force a
// confirmation-depth advance + backoff instead of re-oscillating forever.
const MAX_CONSECUTIVE_REORGS = parseInt(process.env.MAX_CONSECUTIVE_REORGS || '5', 10);
// Graph-Node: transact_block_operations — batch DB writes
const BATCH_SET_INDEXED = parseInt(process.env.BATCH_SET_INDEXED || '10', 10);
let setIndexedCounter = 0;`
    },
    {
        name: '#3 Confirmation-depth reorg skip (measured against LIVE tip, not stale preloadEndBlock)',
        find: `                const parentHash = await this.getBlockHash(blockNumber - 1);
                const nextBlockNumber = await this.indexer
                    .getProvider()
                    .processBlock(blockNumber, parentHash);`,
        replace: `                // Confirmation depth: skip the ancestor_block (reorg) check when the
                // block is either far behind the preload window (fast historical sync)
                // OR within REORG_CONFIRMATIONS of the LIVE tip (where upstreams
                // disagree on hashes and cause false-reorg oscillation). The live tip
                // is read from a short-lived cache to avoid an RPC call per block.
                let parentHash = null;
                const behindPreload = (this.preloadEndBlock || 0) - blockNumber;
                let withinConfirmations = false;
                try {
                    const now = Date.now();
                    if (!this._tipCache || (now - this._tipCache.at) > 4000) {
                        const liveTip = await this.indexer.getProvider().getLatestBlockNumber();
                        this._tipCache = { tip: liveTip, at: now };
                    }
                    withinConfirmations = (this._tipCache.tip - blockNumber) <= REORG_CONFIRMATIONS;
                } catch (e) {
                    // If tip lookup fails, fall back to the historical-sync skip only.
                    withinConfirmations = false;
                }
                const skipReorg = (behindPreload > SKIP_REORG_THRESHOLD) || withinConfirmations;
                if (!skipReorg) {
                    parentHash = await this.getBlockHash(blockNumber - 1);
                }
                const nextBlockNumber = await this.indexer
                    .getProvider()
                    .processBlock(blockNumber, parentHash);`
    },
    {
        name: '#4 Batch setLastIndexedBlock (Graph-Node: single transact per batch)',
        find: `    async setLastIndexedBlock(block) {
        await this.store.setMetadata(this.indexerName, checkpoints_1.MetadataId.LastIndexedBlock, block);
    }`,
        replace: `    async setLastIndexedBlock(block) {
        // Graph-Node: transact_block_operations writes block ptr once per batch
        setIndexedCounter++;
        if (setIndexedCounter % BATCH_SET_INDEXED === 0) {
            await this.store.setMetadata(this.indexerName, checkpoints_1.MetadataId.LastIndexedBlock, block);
        }
    }`
    },
    {
        name: '#5 Per-chain block range (Graph-Node: per-provider config)',
        find: `        this.indexerName = indexerName;`,
        replace: `        this.indexerName = indexerName;
        // Graph-Node: per-provider max_block_range_size — e.g. MAINNET_BLOCK_RANGE=50000
        const perChainRange = process.env[indexerName.toUpperCase() + '_BLOCK_RANGE'];
        if (perChainRange) {
            this.preloadStep = parseInt(perChainRange, 10);
            console.log('[' + indexerName + '] block range override: ' + this.preloadStep);
        }`
    },
    {
        name: '#6 Reorg loop-breaker: cap consecutive reorgs on same block + advance past confirmation depth',
        find: `                else if (err instanceof providers_1.ReorgDetectedError) {
                    blockNumber = await this.handleReorg(blockNumber);
                    continue;
                }`,
        replace: `                else if (err instanceof providers_1.ReorgDetectedError) {
                    // Loop-breaker: count consecutive reorgs that resolve to the SAME
                    // block. A genuine reorg resolves once and advances; an upstream
                    // hash-disagreement oscillates on a fixed block forever.
                    if (this._reorgLoopBlock === blockNumber) {
                        this._reorgLoopCount = (this._reorgLoopCount || 0) + 1;
                    } else {
                        this._reorgLoopBlock = blockNumber;
                        this._reorgLoopCount = 1;
                    }
                    let resolvedBlock = await this.handleReorg(blockNumber);
                    if (this._reorgLoopCount >= MAX_CONSECUTIVE_REORGS) {
                        // We are stuck on a tip-edge hash disagreement, not a real reorg.
                        // Drop the in-memory hash caches so the next read is fresh, back
                        // off long enough for upstreams to converge, and advance to a
                        // depth where reorg checks are skipped. blockHashCache/cpBlocksCache
                        // are already cleared by handleReorg.
                        this.log.warn({ blockNumber, count: this._reorgLoopCount }, 'reorg loop detected — flushing caches, backing off, re-resolving against fresh hashes');
                        this.blockHashCache = null;
                        this._tipCache = null;
                        // Flush the provider's in-memory block cache. It can hold an
                        // ORPHANED hash for the reorged block (the same value the proxy
                        // may also have served), which makes handleReorg keep resolving
                        // to the wrong "good" block. Clearing it forces a fresh RPC read
                        // of the CANONICAL hash, so the next handleReorg rewinds to the
                        // true common ancestor and advances correctly.
                        try { this.indexer.getProvider().clearBlockCache(); } catch (e) { /* older provider */ }
                        await (0, helpers_1.sleep)(Math.min(this.config.fetch_interval || DEFAULT_FETCH_INTERVAL, 5000) * this._reorgLoopCount);
                        this._reorgLoopCount = 0;
                        this._reorgLoopBlock = null;
                        // Re-run handleReorg now that caches are fresh so we rewind to the
                        // genuine common ancestor instead of re-oscillating on the same block.
                        resolvedBlock = await this.handleReorg(blockNumber);
                    }
                    blockNumber = resolvedBlock;
                    continue;
                }`
    }
]);

// ============================================================
// 3. MODEL.JS — idempotent entity writes (delete-all then insert)
// ============================================================
// Graph-Node: entities have ONE current version. On re-index, old versions
// are removed. Exclusion constraints (block_range gist) prevent ON CONFLICT.

patchFile('orm/model.js', [
    {
        name: '#1 _insert: delete-all-then-insert (handles exclusion constraints)',
        find: `    async _insert() {
        const currentBlock = register_1.register.getCurrentBlock(this.indexerName);
        const entity = Object.fromEntries(this.values.entries());
        return register_1.register
            .getKnex()
            .table(this.tableName)
            .insert({
            ...entity,
            _indexer: this.indexerName,
            block_range: register_1.register
                .getKnex()
                .raw('int8range(?, NULL)', [currentBlock])
        });
    }`,
        replace: `    async _insert() {
        // Graph-Node: entity versioning — delete ALL old versions, insert fresh
        const currentBlock = register_1.register.getCurrentBlock(this.indexerName);
        const entity = Object.fromEntries(this.values.entries());
        const knex = register_1.register.getKnex();
        
        // Delete ALL existing rows for this entity (open + closed block_ranges)
        await knex.table(this.tableName)
            .where('id', entity.id)
            .andWhere('_indexer', this.indexerName)
            .del();
        
        return knex.table(this.tableName).insert({
            ...entity,
            _indexer: this.indexerName,
            block_range: knex.raw('int8range(?, NULL)', [currentBlock])
        });
    }`
    },
    {
        name: '#2 _update: delete-all-then-insert (Graph-Node: single current version)',
        find: `    async _update() {
        const knex = register_1.register.getKnex();
        const currentBlock = register_1.register.getCurrentBlock(this.indexerName);
        const diff = Object.fromEntries([...this.values.entries()].filter(([key]) => this.valuesImplicitlySet.has(key)));
        return knex.transaction(async (trx) => {
            await trx
                .table(this.tableName)
                .where('id', this.get('id'))
                .andWhere('_indexer', this.indexerName)
                .andWhereRaw('upper_inf(block_range)')
                .update({
                block_range: knex.raw('int8range(lower(block_range), ?)', [
                    currentBlock
                ])
            });
            const newEntity = {
                ...Object.fromEntries(this.values.entries()),
                ...diff
            };
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { uid, ...currentValues } = newEntity;
            await trx.table(this.tableName).insert({
                ...currentValues,
                block_range: knex.raw('int8range(?, NULL)', [currentBlock])
            });
        });
    }`,
        replace: `    async _update() {
        // Graph-Node: delete ALL old versions, insert single current version
        const knex = register_1.register.getKnex();
        const currentBlock = register_1.register.getCurrentBlock(this.indexerName);
        const diff = Object.fromEntries([...this.values.entries()].filter(([key]) => this.valuesImplicitlySet.has(key)));
        return knex.transaction(async (trx) => {
            // Delete ALL versions (open + closed block_ranges) — no constraint issues
            await trx.table(this.tableName)
                .where('id', this.get('id'))
                .andWhere('_indexer', this.indexerName)
                .del();
            const newEntity = {
                ...Object.fromEntries(this.values.entries()),
                ...diff
            };
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { uid, ...currentValues } = newEntity;
            await trx.table(this.tableName).insert({
                ...currentValues,
                block_range: knex.raw('int8range(?, NULL)', [currentBlock])
            });
        });
    }`
    }
]);

// ============================================================
// 4. HELPERS.JS — error resilience (-32603 range halving)
// ============================================================

patchFile('providers/evm/helpers.js', [
    {
        name: '#1 Handle -32603 (Graph-Node: retry with range halving)',
        find: `    return null;\n}`,
        replace: `    // PublicNode -32603: eth_getLogs range is too large, max 1k blocks
    if (err.code === -32603 && err.message && err.message.includes('range is too large')) {
        return {
            from: currentRange.from,
            to: currentRange.from + Math.ceil((currentRange.to - currentRange.from) / 2)
        };
    }
    return null;\n}`
    }
]);

// ============================================================
// 5. CHECKPOINTS.JS — idempotent setBlockHash
// ============================================================

patchFile('stores/checkpoints.js', [
    {
        name: '#1 Upsert setBlockHash (Graph-Node: cache = natural overwrite)',
        find: `    async setBlockHash(indexer, blockNumber, hash) {
        await this.knex.table(exports.Table.Blocks).insert({
            [exports.Fields.Blocks.Indexer]: indexer,
            [exports.Fields.Blocks.Number]: blockNumber,
            [exports.Fields.Blocks.Hash]: hash
        });
    }`,
        replace: `    async setBlockHash(indexer, blockNumber, hash) {
        // Graph-Node: block cache naturally handles duplicate writes
        await this.knex.table(exports.Table.Blocks).insert({
            [exports.Fields.Blocks.Indexer]: indexer,
            [exports.Fields.Blocks.Number]: blockNumber,
            [exports.Fields.Blocks.Hash]: hash
        }).onConflict([exports.Fields.Blocks.Indexer, exports.Fields.Blocks.Number]).merge();
    }`
    }
]);

console.log('=== All patches applied successfully ===\n');
