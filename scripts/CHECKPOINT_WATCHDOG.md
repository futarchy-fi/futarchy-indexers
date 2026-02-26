# Checkpoint Indexer Watchdog

## Why This Exists

Checkpoint indexers can get stuck in **reorg loops** — an infinite cycle where the indexer detects a blockchain reorganization, rolls back, re-indexes the same block, and repeats. This prevents the indexer from advancing and causes stale data.

### Real Example (Feb 25, 2026)

The registry indexer got stuck at block **44,838,761** for **13+ hours**:

```
[12:18:26] reorg resolved    blockNumber: 44838761
[12:18:26] reorg detected    blockNumber: 44838762  ← infinite loop
[12:18:26] reorg resolved    blockNumber: 44838761
[12:18:27] reorg detected    blockNumber: 44838762  ← repeats every 300ms
```

**Root cause:** Public RPCs are load-balanced. Different requests hit different nodes with slightly different chain tips. The indexer sees changing block hashes and interprets this as a reorg endlessly.

---

## Features

### 1. Stuck Detection & Auto-Restart
Checks block progress every 5 min. If block hasn't advanced in 2 checks (10 min) → restart the container.

### 2. Adaptive RPC Switching
Automatically uses the best RPC for the situation:

| Condition | Action | RPC |
|-----------|--------|-----|
| Gap > 1000 blocks | Switch to **FAST** (paid) for quick catch-up | QuickNode, Infura, etc. |
| Gap < 100 blocks | Switch to **FREE** (public) to save cost | `rpc.gnosischain.com` |
| Stuck (no progress) | Restart with **FAST** RPC | QuickNode, Infura, etc. |

```
Indexer 4000 blocks behind
    → ⚡ Switch to FAST RPC (paid)
    → Catches up at ~700 blocks/sec
    → Gap drops to 50 blocks
    → 💰 Switch to FREE RPC (public)
    → Follows chain tip at normal speed
```

### 3. Multi-Network Support
Candles indexes both Gnosis and Mainnet. The watchdog tracks all networks — if any chain stalls, the container restarts.

---

## Setup

### 1. Configure RPCs

```bash
cp scripts/.env.example scripts/.env
```

Edit `scripts/.env` with your paid RPC URLs:

```bash
# Fast RPCs (paid, for catching up)
FAST_GNOSIS_RPC_URL=https://your-quicknode.xdai.quiknode.pro/YOUR_KEY/
FAST_MAINNET_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
```

> **Note:** `scripts/.env` is gitignored — never committed. If you don't set paid RPCs, the watchdog still works — it just uses the free RPCs for everything.

### 2. Install Cron Job

```bash
crontab -e
# Add this line:
*/5 * * * * /home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh >> /var/log/checkpoint-watchdog.log 2>&1
```

### 3. Verify

```bash
# Check cron
crontab -l | grep watchdog

# Manual run
/home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh

# Check logs
tail -20 /var/log/checkpoint-watchdog.log
```

---

## Indexers Monitored

| Indexer | Container | Port | Networks | RPC Env Var |
|---------|-----------|------|----------|-------------|
| **Registry** | `futarchy-registry-checkpoint` | 3003 | Gnosis | `RPC_URL` |
| **Candles** | `checkpoint-checkpoint-1` | 3001 | Gnosis + Mainnet | `GNOSIS_RPC_URL`, `MAINNET_RPC_URL` |

---

## Log Examples

**Normal operation:**
```
[12:25:00] 📊 registry: blocks=[44877393] gap=8 rpc=free
[12:25:00] 📊 candles: blocks=[0,40683474] gap=4193000 rpc=free
```

**Switching to fast RPC:**
```
[12:25:00] 📊 candles: blocks=[0,40683474] gap=4193000 rpc=free
[12:25:00] ⚡ candles: 4193000 blocks behind — switching to FAST RPC
[12:25:02] ✅ checkpoint-checkpoint-1 restarted
```

**Caught up, switching back to free:**
```
[12:55:00] 📊 candles: blocks=[23420000,44877400] gap=50 rpc=fast
[12:55:00] 💰 candles: Caught up (gap=50) — switching to FREE RPC
```

**Stuck detection:**
```
[12:30:00] 📊 registry: blocks=[44838761] gap=38000 rpc=free
[12:35:00] 🚨 registry: STUCK — restarting with FAST RPC
```

---

## Configuration

Edit these in the script:

| Setting | Default | Description |
|---------|---------|-------------|
| `FAR_BEHIND_THRESHOLD` | 1000 | Switch to fast RPC when gap > this |
| `CAUGHT_UP_THRESHOLD` | 100 | Switch to free RPC when gap < this |
| Cron interval | `*/5` (5 min) | How often to check |

---

## Disable

```bash
crontab -e
# Remove or comment out the watchdog line
```
