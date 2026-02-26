# Checkpoint Indexer Watchdog

## Why This Exists

Checkpoint indexers can get stuck in **reorg loops** — an infinite cycle where the indexer detects a blockchain reorganization, rolls back, re-indexes the same block, and immediately detects another reorg. This prevents the indexer from advancing and causes stale data.

### Real Example (Feb 25, 2026)

The registry indexer got stuck at block **44,838,761** for **13+ hours** while the chain was at **44,877,307**:

```
[12:18:26.568] INFO: reorg resolved        blockNumber: 44838761
[12:18:26.884] ERROR: reorg detected        blockNumber: 44838762
[12:18:26.884] INFO: handling reorg         blockNumber: 44838762
[12:18:26.915] INFO: reorg resolved         blockNumber: 44838761
[12:18:27.254] ERROR: reorg detected        blockNumber: 44838762  ← infinite loop
```

**Impact:** New proposals (like the Kleros PNK proposal) had their `snapshot_id` metadata written to the chain *after* the stuck block, so the charts API couldn't resolve them — returning empty data instead.

### Root Cause

Public RPCs like `rpc.gnosischain.com` are load-balanced across multiple nodes. When the indexer is near the chain tip, consecutive requests can hit different nodes with slightly different views of the latest blocks. The indexer sees different block hashes and interprets this as a reorg, rolling back and retrying endlessly.

A restart fixes it because the problematic block is hours old and well-confirmed by then.

---

## The Watchdog

**Script:** `scripts/checkpoint-watchdog.sh`

Runs via cron every 5 minutes. Checks if each indexer's block number is advancing. If it hasn't moved in **10 minutes** (2 checks), the container gets auto-restarted.

### What It Monitors

| Indexer | Container | Port | Networks |
|---------|-----------|------|----------|
| **Registry** | `futarchy-registry-checkpoint` | 3003 | Gnosis |
| **Candles** | `checkpoint-checkpoint-1` | 3001 | Gnosis + Mainnet |

### How It Works

```
Check 1 (0 min):  registry=44838761  → saved to /tmp
Check 2 (5 min):  registry=44838761  → SAME! → 🚨 STUCK → restart container
Check 3 (10 min): registry=44878000  → advancing normally ✅
```

For multi-network indexers (candles), it tracks ALL networks together. If any chain stops advancing, the container restarts.

---

## Setup

### Install Cron Job

```bash
crontab -e
```

Add this line:

```
*/5 * * * * /home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh >> /var/log/checkpoint-watchdog.log 2>&1
```

### Verify It's Running

```bash
crontab -l | grep watchdog
```

### Check Logs

```bash
tail -20 /var/log/checkpoint-watchdog.log
```

Expected output:

```
[2026-02-26 12:21:37] 🔍 Checkpoint Watchdog Running
[2026-02-26 12:21:37] 📊 registry: blocks=[44877393] (prev=[44877300])
[2026-02-26 12:21:37] 📊 candles: blocks=[23420000,40683474] (prev=[23419500,40683000])
```

### Manual Run

```bash
/home/ubuntu/futarchy-subgraphs/scripts/checkpoint-watchdog.sh
```

### When It Restarts a Container

```
[2026-02-26 12:21:49] 📊 registry: blocks=[44838761] (prev=[44838761])
[2026-02-26 12:21:49] 🚨 registry: STUCK at blocks [44838761] — restarting futarchy-registry-checkpoint...
futarchy-registry-checkpoint
[2026-02-26 12:21:49] ✅ registry: Restarted
```

---

## Configuration

Edit the script to change:

| Setting | Default | Description |
|---------|---------|-------------|
| Cron interval | `*/5` | How often to check (minutes) |
| Stuck threshold | 2 checks | Restart after block unchanged for 2 consecutive checks |
| State directory | `/tmp/checkpoint-watchdog` | Where prev blocks are stored |

### Changing Containers

If container names change, update these lines in the script:

```bash
REGISTRY_CONTAINER="futarchy-registry-checkpoint"
CANDLES_CONTAINER="checkpoint-checkpoint-1"
```

---

## Disable

```bash
crontab -e
# Remove or comment out the watchdog line
```

---

## Limitations

- **Reorg loops are symptoms.** The root cause is public RPC inconsistency. A dedicated RPC (QuickNode, Infura) would reduce but not eliminate the risk.
- **Restart is a blunt fix.** The indexer resumes from its last checkpoint, which means a brief gap in live data during restart (~30-60s).
- **Multi-network indexers restart fully.** If only mainnet is stuck but Gnosis is fine, both get restarted. This is acceptable since restarts are fast.
