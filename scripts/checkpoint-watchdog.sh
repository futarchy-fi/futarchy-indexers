#!/bin/bash
# ============================================================================
# Checkpoint Indexer Watchdog
#
# Detects stuck indexers (reorg loops, crashes) and auto-restarts them.
# Runs via cron every 5 minutes.
#
# Setup:
#   crontab -e
#   */5 * * * * /home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh >> /var/log/checkpoint-watchdog.log 2>&1
#
# How it works:
#   1. Queries each indexer's last_indexed_block via GraphQL
#   2. Compares to the previous check (stored in /tmp)
#   3. If block hasn't advanced in 2 checks (10 min), restart the container
#   4. Handles multi-network indexers (e.g. candles has gnosis + mainnet)
# ============================================================================

REGISTRY_URL="http://localhost:3003/graphql"
REGISTRY_CONTAINER="futarchy-registry-checkpoint"

CANDLES_URL="http://localhost:3001/graphql"
CANDLES_CONTAINER="checkpoint-checkpoint-1"

STATE_DIR="/tmp/checkpoint-watchdog"
mkdir -p "$STATE_DIR"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ── Helper: get all last_indexed_block values as comma-separated string ──
# Returns "block1,block2" for multi-network or just "block" for single
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

# ── Helper: check and restart if stuck ──
check_indexer() {
    local name=$1
    local url=$2
    local container=$3
    local state_file="$STATE_DIR/$name"

    local current_blocks=$(get_blocks "$url")

    if [ "$current_blocks" = "0" ] || [ -z "$current_blocks" ]; then
        echo "[$TIMESTAMP] ⚠️  $name: Can't reach GraphQL at $url"
        echo "[$TIMESTAMP] 🔄 $name: Restarting container $container..."
        docker restart "$container" 2>&1
        echo "[$TIMESTAMP] ✅ $name: Restarted"
        rm -f "$state_file"
        return
    fi

    # Read previous blocks
    local prev_blocks="0"
    if [ -f "$state_file" ]; then
        prev_blocks=$(cat "$state_file")
    fi

    echo "[$TIMESTAMP] 📊 $name: blocks=[$current_blocks] (prev=[$prev_blocks])"

    if [ "$current_blocks" = "$prev_blocks" ] && [ "$prev_blocks" != "0" ]; then
        echo "[$TIMESTAMP] 🚨 $name: STUCK at blocks [$current_blocks] — restarting $container..."
        docker restart "$container" 2>&1
        echo "[$TIMESTAMP] ✅ $name: Restarted"
        rm -f "$state_file"
    else
        echo "$current_blocks" > "$state_file"
    fi
}

# ── Run checks ──
echo ""
echo "[$TIMESTAMP] 🔍 Checkpoint Watchdog Running"
check_indexer "registry" "$REGISTRY_URL" "$REGISTRY_CONTAINER"
check_indexer "candles"  "$CANDLES_URL"  "$CANDLES_CONTAINER"
