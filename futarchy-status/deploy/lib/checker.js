const REGISTRY_URL = 'https://api.futarchy.fi/registry/graphql';
const CANDLES_URL = 'https://api.futarchy.fi/candles/graphql';

const GNOSIS_RPC = 'https://rpc.gnosischain.com';
const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';

const GAP_THRESHOLD_DEGRADED = 100; // If indexer is >100 blocks behind chain head -> degraded

async function fetchChainHead(rpcUrl) {
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        });
        const data = await res.json();
        return parseInt(data.result, 16);
    } catch (e) {
        return null;
    }
}

async function fetchIndexerBlocks(graphqlUrl) {
    try {
        const res = await fetch(graphqlUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Request the 'indexer' field so we can reliably match chain→block
            body: JSON.stringify({ query: '{ _metadatas { id indexer value } }' })
        });
        const data = await res.json();

        const metadatas = data.data._metadatas;
        const result = {};

        // Use the 'indexer' field to match each last_indexed_block to its chain.
        // Old approach matched by array index which broke when the DB returned
        // network_identifier and last_indexed_block rows in different order.
        for (const m of metadatas) {
            if (m.id === 'last_indexed_block') {
                if (m.indexer === 'gnosis') result.gnosis = parseInt(m.value);
                else if (m.indexer === 'mainnet') result.mainnet = parseInt(m.value);
            }
        }

        // Fallback for single-network indexers (like registry) that may not have
        // an 'indexer' field — use the highest block number.
        if (!result.gnosis && !result.mainnet) {
            const blocks = metadatas
                .filter(m => m.id === 'last_indexed_block')
                .map(m => parseInt(m.value));
            if (blocks.length > 0) result.gnosis = Math.max(...blocks);
        }

        return result;
    } catch (e) {
        return null;
    }
}

async function checkHttpGet(url) {
    try {
        const res = await fetch(url);
        return res.ok;
    } catch (e) {
        return false;
    }
}

export async function checkAllSystems() {
    const startTime = Date.now();

    // Fire all requests concurrently
    const [
        twapOk,
        chartsOk,
        gnosisHead,
        mainnetHead,
        registryBlocks,
        candlesBlocks
    ] = await Promise.all([
        checkHttpGet('https://api.futarchy.fi/health'),
        checkHttpGet('https://api.futarchy.fi/charts/warmer'),
        fetchChainHead(GNOSIS_RPC),
        fetchChainHead(MAINNET_RPC),
        fetchIndexerBlocks(REGISTRY_URL),
        fetchIndexerBlocks(CANDLES_URL)
    ]);

    const results = [
        {
            id: 'twap',
            name: 'TWAP API',
            status: twapOk ? 'operational' : 'outage',
            description: twapOk ? 'Serving time-weighted average prices correctly' : 'Unreachable or returning errors'
        },
        {
            id: 'charts',
            name: 'Charts API',
            status: chartsOk ? 'operational' : 'outage',
            description: chartsOk ? 'Serving unified charts and caching correctly' : 'Unreachable or returning errors'
        }
    ];

    // REGISTRY STATUS
    let registryStatus = 'outage';
    let registryDesc = 'Unreachable';
    if (registryBlocks && registryBlocks.gnosis && gnosisHead) {
        const gap = gnosisHead - registryBlocks.gnosis;
        if (gap < GAP_THRESHOLD_DEGRADED) {
            registryStatus = 'operational';
            registryDesc = `Synced with Gnosis Chain (gap: ${gap} blocks)`;
        } else {
            registryStatus = 'degraded';
            registryDesc = `Catching up to Gnosis Chain (${gap} blocks behind)`;
        }
    }
    results.push({ id: 'registry', name: 'Registry Indexer', status: registryStatus, description: registryDesc });

    // CANDLES STATUS (GNOSIS)
    let candlesGnosisStatus = 'outage';
    let candlesGnosisDesc = 'Unreachable';
    if (candlesBlocks && candlesBlocks.gnosis !== undefined && gnosisHead) {
        const gap = gnosisHead - candlesBlocks.gnosis;
        if (gap < GAP_THRESHOLD_DEGRADED) {
            candlesGnosisStatus = 'operational';
            candlesGnosisDesc = `Synced with Gnosis Chain (gap: ${gap} blocks)`;
        } else {
            candlesGnosisStatus = 'degraded';
            candlesGnosisDesc = `Catching up to Gnosis Chain (${gap} blocks behind)`;
        }
    }
    results.push({ id: 'candles_gnosis', name: 'Candles Indexer (Gnosis)', status: candlesGnosisStatus, description: candlesGnosisDesc });

    // CANDLES STATUS (MAINNET)
    let candlesMainnetStatus = 'outage';
    let candlesMainnetDesc = 'Unreachable';
    if (candlesBlocks && candlesBlocks.mainnet !== undefined && mainnetHead) {
        const gap = mainnetHead - candlesBlocks.mainnet;
        if (gap < GAP_THRESHOLD_DEGRADED) {
            candlesMainnetStatus = 'operational';
            candlesMainnetDesc = `Synced with Ethereum Mainnet (gap: ${gap} blocks)`;
        } else {
            candlesMainnetStatus = 'degraded';
            candlesMainnetDesc = `Catching up to Ethereum Mainnet (${gap} blocks behind)`;
        }
    }
    results.push({ id: 'candles_mainnet', name: 'Candles Indexer (Mainnet)', status: candlesMainnetStatus, description: candlesMainnetDesc });


    // Overall Status
    const isMajorOutage = results.some(r => r.status === 'outage');
    const isDegraded = results.some(r => r.status === 'degraded');

    let overall = 'operational';
    if (isMajorOutage) overall = 'outage';
    else if (isDegraded) overall = 'degraded';

    return {
        overall,
        components: results,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime
    };
}
