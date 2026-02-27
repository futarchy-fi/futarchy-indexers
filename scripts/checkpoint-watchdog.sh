#!/bin/bash
# ============================================================================
# Checkpoint Indexer Watchdog
#
# Detects stuck indexers and auto-restarts them.
# Switches RPCs (fast/free) by editing rpc-config.json + docker restart
# which preserves in-memory sync state (ZERO blocks lost).
#
# ⚠️  This script NEVER uses `docker compose down/up`.
# It only uses `docker restart` which preserves in-memory state.
#
# RPC switching works via the mounted /app/rpc-config.json:
#   1. Edit rpc-config.json "active" field (fast → free or free → fast)
#   2. docker restart (preserves state, reads new config on boot)
#
# Setup:
#   crontab: */5 * * * * /home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh >> /home/ubuntu/checkpoint-watchdog.log 2>&1
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Config ──
RPC_CONFIG="/home/ubuntu/futarchy-subgraphs/rpc-config.json"
FAR_BEHIND_THRESHOLD=1000   # Switch to FAST if > this many blocks behind
CAUGHT_UP_THRESHOLD=100     # Switch to FREE if < this many blocks behind

# ── Indexer configs ──
REGISTRY_URL="http://localhost:3003/graphql"
REGISTRY_CONTAINER="futarchy-registry-checkpoint"

CANDLES_URL="http://localhost:3001/graphql"
CANDLES_CONTAINER="checkpoint-checkpoint-1"

STATE_DIR="/tmp/checkpoint-watchdog"
mkdir -p "$STATE_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ── Helper: get chain head block ──
get_chain_head() {
    local rpc_url=$1
    curl -sf -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
        "$rpc_url" 2>/dev/null | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    print(int(r['result'], 16))
except:
    print('0')
" 2>/dev/null
}

# ── Helper: get all last_indexed_block values ──
get_blocks() {
    local url=$1
    curl -sf -H "Content-Type: application/json" \
        -d '{"query":"{ _metadatas(where: { id: \"last_indexed_block\" }) { value } }"}' \
        "$url" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    blocks = [m['value'] for m in d['data']['_metadatas']]
    print(','.join(blocks) if blocks else '0')
except:
    print('0')
" 2>/dev/null
}

# ── Helper: get the max block from comma-separated list ──
max_block() {
    echo "$1" | tr ',' '\n' | sort -n | tail -1
}

# ── Helper: get current active RPC from config ──
get_active_rpc() {
    python3 -c "
import json
try:
    with open('$RPC_CONFIG') as f:
        print(json.load(f).get('active', 'fast'))
except:
    print('fast')
" 2>/dev/null
}

# ── Helper: switch RPC in config file (no container restart here) ──
switch_rpc() {
    local new_mode=$1
    python3 -c "
import json
with open('$RPC_CONFIG', 'r') as f:
    config = json.load(f)
config['active'] = '$new_mode'
with open('$RPC_CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" 2>/dev/null
}

# ── Main: check if indexer is stuck and manage RPC switching ──
check_indexer() {
    local name=$1
    local url=$2
    local container=$3
    local chain_rpc=$4
    local state_file="$STATE_DIR/$name"
    local stuck_count_file="$STATE_DIR/${name}_stuck_count"

    local current_blocks=$(get_blocks "$url")

    # Can't reach indexer
    if [ "$current_blocks" = "0" ] || [ -z "$current_blocks" ]; then
        echo "[$TIMESTAMP] ⚠️  $name: Can't reach GraphQL at $url — restarting (docker restart)"
        docker restart "$container" 2>&1
        echo "[$TIMESTAMP] ✅ $container restarted (preserves in-memory state)"
        rm -f "$state_file" "$stuck_count_file"
        return
    fi

    # Get chain head for gap calculation
    local chain_head=$(get_chain_head "$chain_rpc")
    local indexer_block=$(max_block "$current_blocks")
    local gap=$((chain_head - indexer_block))

    # Read previous state
    local prev_blocks="0"
    [ -f "$state_file" ] && prev_blocks=$(cat "$state_file")

    local current_rpc=$(get_active_rpc)

    echo "[$TIMESTAMP] 📊 $name: blocks=[$current_blocks] gap=${gap} rpc=${current_rpc} (prev=[$prev_blocks])"

    # Check if STUCK (same block as last check)
    if [ "$current_blocks" = "$prev_blocks" ] && [ "$prev_blocks" != "0" ]; then
        local stuck_count=0
        [ -f "$stuck_count_file" ] && stuck_count=$(cat "$stuck_count_file")
        stuck_count=$((stuck_count + 1))
        echo "$stuck_count" > "$stuck_count_file"

        if [ "$stuck_count" -ge 2 ]; then
            echo "[$TIMESTAMP] 🚨 $name: STUCK for ${stuck_count} checks — restarting (docker restart)"
            docker restart "$container" 2>&1
            echo "[$TIMESTAMP] ✅ $container restarted (preserves in-memory state)"
            rm -f "$state_file" "$stuck_count_file"
        else
            echo "[$TIMESTAMP] ⏳ $name: No progress (stuck check $stuck_count/2) — waiting"
        fi
        return
    fi

    # Making progress — reset stuck counter
    rm -f "$stuck_count_file"

    # ── RPC switching (only for candles, registry stays on free) ──
    if [ "$name" = "candles" ]; then
        # FAR BEHIND → switch to FAST RPC
        if [ "$gap" -gt "$FAR_BEHIND_THRESHOLD" ] && [ "$current_rpc" != "fast" ]; then
            echo "[$TIMESTAMP] ⚡ $name: ${gap} blocks behind — switching to FAST RPC"
            switch_rpc "fast"
            docker restart "$container" 2>&1
            echo "[$TIMESTAMP] ✅ $container restarted with FAST RPC (state preserved)"
        fi

        # CAUGHT UP → switch back to FREE RPC
        if [ "$gap" -lt "$CAUGHT_UP_THRESHOLD" ] && [ "$current_rpc" = "fast" ]; then
            echo "[$TIMESTAMP] 💰 $name: Caught up (gap=${gap}) — switching to FREE RPC"
            switch_rpc "free"
            docker restart "$container" 2>&1
            echo "[$TIMESTAMP] ✅ $container restarted with FREE RPC (state preserved)"
        fi
    fi

    # Save current state
    echo "$current_blocks" > "$state_file"
}

# ── Run checks ──
echo ""
echo "[$TIMESTAMP] 🔍 Checkpoint Watchdog Running"
check_indexer "registry" "$REGISTRY_URL" "$REGISTRY_CONTAINER" "https://rpc.gnosischain.com"
check_indexer "candles"  "$CANDLES_URL"  "$CANDLES_CONTAINER"  "https://rpc.gnosischain.com"
