#!/bin/bash
# ============================================================================
# Checkpoint Indexer Watchdog
#
# Detects stuck indexers (reorg loops, crashes) and auto-restarts them.
# Also switches between FAST (paid) and FREE (public) RPCs based on sync gap.
#
# Setup:
#   1. Copy .env.example to .env and set your paid RPC URLs
#   2. Install cron:
#      */5 * * * * /home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh >> /var/log/checkpoint-watchdog.log 2>&1
#
# How it works:
#   - Checks if each indexer's block is advancing
#   - If stuck for 2 checks (10 min) → restart container
#   - If far behind (>1000 blocks) → restart with FAST RPC
#   - If caught up (<100 blocks) → switch back to FREE RPC (saves cost)
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load env file if exists (contains paid RPC URLs)
if [ -f "$SCRIPT_DIR/.env" ]; then
    source "$SCRIPT_DIR/.env"
fi

# ── RPC URLs ──
# Fast (paid) — used when catching up from far behind
FAST_GNOSIS_RPC="${FAST_GNOSIS_RPC_URL:-https://rpc.gnosischain.com}"
FAST_MAINNET_RPC="${FAST_MAINNET_RPC_URL:-https://eth.llamarpc.com}"

# Free (public) — used when synced and just following the tip
FREE_GNOSIS_RPC="https://rpc.gnosischain.com"
FREE_MAINNET_RPC="https://eth.llamarpc.com"

# ── Thresholds ──
FAR_BEHIND_THRESHOLD=1000   # Switch to FAST if > this many blocks behind
CAUGHT_UP_THRESHOLD=100     # Switch to FREE if < this many blocks behind

# ── Indexer configs ──
REGISTRY_URL="http://localhost:3003/graphql"
REGISTRY_CONTAINER="futarchy-registry-checkpoint"
REGISTRY_COMPOSE="/home/ubuntu/futarchy-subgraphs/futarchy-complete/checkpoint"

CANDLES_URL="http://localhost:3001/graphql"
CANDLES_CONTAINER="checkpoint-checkpoint-1"
CANDLES_COMPOSE="/home/ubuntu/futarchy-subgraphs/proposals-candles/checkpoint"

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

# ── Helper: restart container with specific RPC ──
restart_with_rpc() {
    local container=$1
    local compose_dir=$2
    local gnosis_rpc=$3
    local mainnet_rpc=$4
    local reason=$5

    echo "[$TIMESTAMP] 🔄 Restarting $container ($reason)"

    if [ -n "$mainnet_rpc" ]; then
        # Candles: has both RPCs
        GNOSIS_RPC_URL="$gnosis_rpc" MAINNET_RPC_URL="$mainnet_rpc" \
            docker compose -f "$compose_dir/docker-compose.yml" up -d --force-recreate checkpoint 2>&1
    else
        # Registry: has single RPC
        RPC_URL="$gnosis_rpc" \
            docker compose -f "$compose_dir/docker-compose.yml" up -d --force-recreate registry-checkpoint 2>&1
    fi

    echo "[$TIMESTAMP] ✅ $container restarted"
}

# ── Main: check and manage indexer ──
check_indexer() {
    local name=$1
    local url=$2
    local container=$3
    local compose_dir=$4
    local chain_rpc=$5
    local has_mainnet=$6
    local state_file="$STATE_DIR/$name"
    local rpc_state_file="$STATE_DIR/${name}_rpc"

    local current_blocks=$(get_blocks "$url")

    # Can't reach indexer
    if [ "$current_blocks" = "0" ] || [ -z "$current_blocks" ]; then
        echo "[$TIMESTAMP] ⚠️  $name: Can't reach GraphQL at $url — restarting"
        docker restart "$container" 2>&1
        rm -f "$state_file"
        return
    fi

    # Get chain head for gap calculation
    local chain_head=$(get_chain_head "$chain_rpc")
    local indexer_block=$(max_block "$current_blocks")
    local gap=$((chain_head - indexer_block))

    # Read previous state
    local prev_blocks="0"
    [ -f "$state_file" ] && prev_blocks=$(cat "$state_file")

    local current_rpc="free"
    [ -f "$rpc_state_file" ] && current_rpc=$(cat "$rpc_state_file")

    echo "[$TIMESTAMP] 📊 $name: blocks=[$current_blocks] gap=${gap} rpc=${current_rpc} (prev=[$prev_blocks])"

    # Check if STUCK (same block as last check)
    if [ "$current_blocks" = "$prev_blocks" ] && [ "$prev_blocks" != "0" ]; then
        echo "[$TIMESTAMP] 🚨 $name: STUCK — restarting with FAST RPC"
        if [ "$has_mainnet" = "yes" ]; then
            restart_with_rpc "$container" "$compose_dir" "$FAST_GNOSIS_RPC" "$FAST_MAINNET_RPC" "stuck+fast_rpc"
        else
            restart_with_rpc "$container" "$compose_dir" "$FAST_GNOSIS_RPC" "" "stuck+fast_rpc"
        fi
        echo "fast" > "$rpc_state_file"
        rm -f "$state_file"
        return
    fi

    # Check if FAR BEHIND → switch to FAST RPC
    if [ "$gap" -gt "$FAR_BEHIND_THRESHOLD" ] && [ "$current_rpc" != "fast" ]; then
        echo "[$TIMESTAMP] ⚡ $name: ${gap} blocks behind — switching to FAST RPC"
        if [ "$has_mainnet" = "yes" ]; then
            restart_with_rpc "$container" "$compose_dir" "$FAST_GNOSIS_RPC" "$FAST_MAINNET_RPC" "catchup_fast"
        else
            restart_with_rpc "$container" "$compose_dir" "$FAST_GNOSIS_RPC" "" "catchup_fast"
        fi
        echo "fast" > "$rpc_state_file"
        rm -f "$state_file"
        return
    fi

    # Check if CAUGHT UP → switch back to FREE RPC
    if [ "$gap" -lt "$CAUGHT_UP_THRESHOLD" ] && [ "$current_rpc" = "fast" ]; then
        echo "[$TIMESTAMP] 💰 $name: Caught up (gap=${gap}) — switching to FREE RPC"
        if [ "$has_mainnet" = "yes" ]; then
            restart_with_rpc "$container" "$compose_dir" "$FREE_GNOSIS_RPC" "$FREE_MAINNET_RPC" "synced_free"
        else
            restart_with_rpc "$container" "$compose_dir" "$FREE_GNOSIS_RPC" "" "synced_free"
        fi
        echo "free" > "$rpc_state_file"
        rm -f "$state_file"
        return
    fi

    # Save current state
    echo "$current_blocks" > "$state_file"
}

# ── Run checks ──
echo ""
echo "[$TIMESTAMP] 🔍 Checkpoint Watchdog Running"
check_indexer "registry" "$REGISTRY_URL" "$REGISTRY_CONTAINER" "$REGISTRY_COMPOSE" "$FREE_GNOSIS_RPC" "no"
check_indexer "candles"  "$CANDLES_URL"  "$CANDLES_CONTAINER"  "$CANDLES_COMPOSE"  "$FREE_GNOSIS_RPC" "yes"
