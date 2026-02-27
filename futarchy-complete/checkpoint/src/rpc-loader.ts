// Read RPC URLs from the mounted rpc-config.json file.
// This allows switching RPCs with just `docker restart` (no state loss).
//
// Config file format:
// {
//   "active": "fast" | "free",
//   "fast": { "gnosis_rpc": "...", "mainnet_rpc": "..." },
//   "free": { "gnosis_rpc": "...", "mainnet_rpc": "..." }
// }

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.resolve('/app/rpc-config.json');

interface RpcSet {
    gnosis_rpc: string;
    mainnet_rpc: string;
}

interface RpcConfig {
    active: 'fast' | 'free';
    fast: RpcSet;
    free: RpcSet;
}

function loadConfig(): RpcSet {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const config: RpcConfig = JSON.parse(raw);
        const active = config[config.active] || config.fast;
        console.log(`📡 [RPC Config] Using "${config.active}" RPCs from rpc-config.json`);
        console.log(`   Gnosis:  ${active.gnosis_rpc.slice(0, 50)}...`);
        console.log(`   Mainnet: ${active.mainnet_rpc.slice(0, 50)}...`);
        return active;
    } catch (e) {
        console.log(`📡 [RPC Config] No config file found, using env vars / defaults`);
        return {
            gnosis_rpc: process.env.GNOSIS_RPC_URL || process.env.RPC_URL || 'https://rpc.gnosischain.com',
            mainnet_rpc: process.env.MAINNET_RPC_URL || 'https://eth.llamarpc.com'
        };
    }
}

export const rpcConfig = loadConfig();
