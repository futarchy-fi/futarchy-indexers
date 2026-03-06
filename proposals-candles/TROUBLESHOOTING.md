# Troubleshooting: Proposals-Candles Checkpoint Indexer

## Volume Discrepancy Between Graph Node and Checkpoint

### Symptoms
- `pool.volumeToken0/1` in Checkpoint is **lower** than the equivalent volume in Graph Node (algebra-proposal-candles-v1)
- Both indexers show the **same number of swaps** with **identical amounts**
- The gap grows over time and never self-corrects

### Root Cause (Fixed)
The Checkpoint indexer previously accumulated `volumeToken0/1` in an **in-memory cache** (`poolStateCache`) and flushed every `CANDLE_FLUSH_INTERVAL` swaps. On restart or crash, un-flushed volume was lost permanently.

**Why it doesn't self-correct**: Volume is cumulative — once the pool entity is written with a lower-than-expected total, all future additions are based on that stale base. The swap records are correct, but the pool entity is behind.

### Fix Applied
Volume is now persisted directly to DB on every swap (not batched). See `writers.ts` — `volumeToken0/1` was removed from `PoolState` interface. Price/tick/liquidity remain batched since they are "latest value" fields that self-correct on the next swap.

### How to Verify

Run the comparison test from the repo root:
```bash
node tests/14-volume-comparison.js
```

This queries all 4 sources and displays a comparison table:
1. **Graph Node** (CloudFront) — ground truth
2. **Checkpoint** (api.futarchy.fi/candles) — should match Graph Node
3. **Charts API v1** (`/api/v1/market-events/.../prices`)
4. **Charts API v2** (`/api/v2/proposals/.../chart`)

### How to Diagnose Manually

If volumes don't match, sum all swap amounts to find where the gap is:

```bash
# 1. Count swaps on both indexers (should be equal)
# Graph Node:
curl -sX POST https://d3ugkaojqkfud0.cloudfront.net/subgraphs/name/algebra-proposal-candles-v1 \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ swaps(first:1000, where:{pool:\"POOL_ADDRESS\"}) { id } }"}' | jq '.data.swaps | length'

# Checkpoint:
curl -sX POST https://api.futarchy.fi/candles/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ swaps(first:1000, where:{pool:\"100-POOL_ADDRESS\"}) { id } }"}' | jq '.data.swaps | length'

# 2. If counts differ → indexing lag (wait for sync)
# 3. If counts match but volume differs → need re-index to recalculate from scratch
```

### How to Fix Existing Stale Volumes

If the indexer was running the old code and volumes are stale, you need to **reset and re-index**:

```bash
cd proposals-candles/checkpoint
# Reset the database to re-process all events
npx checkpoint reset
npm start
```

After re-indexing with the fixed code, volumes will be correct because every swap now writes volume directly to the pool entity.

---

## v1 vs v2 API Volume Mismatch

### Symptoms
- `/api/v1/market-events/.../prices` returns a different `volume` than `/api/v2/proposals/.../chart`
- The ratio between them is approximately the token price (e.g. 100x for GNO/sDAI)

### Root Cause (Fixed)
- **v1** (`market-events.js`) was returning **company volume** (e.g., GNO) as `volume`
- **v2** (`unified-chart.js`) was returning **currency volume** (e.g., sDAI) as `volume`

### Fix Applied
v1 now uses the same extraction logic as v2: `volume = currencyVolume`, `volume_usd = currencyVolume × currencyRate`.

### How to Verify
```bash
node tests/14-volume-comparison.js
```
The API v1 and v2 rows in the comparison table should now show the same values.

---

## Candle Volume in Wei vs Human-Readable

### Context
- **Graph Node** stores volume as `BigDecimal` (human-readable, divided by 10^decimals at index time)
- **Checkpoint** stores volume as `BigInt` (raw wei, divide by 10^18 at query time)

When comparing raw values between the two, the Checkpoint volume will be ~1e18 times larger. The `candles-adapter.js` in futarchy-charts normalizes Checkpoint values by dividing by 1e18 before returning them.

### Gotcha
If a token has non-18 decimals (e.g., USDC with 6 decimals), dividing by 1e18 will give the wrong result. Currently all futarchy tokens use 18 decimals, but watch for this if new tokens are added.

---

## First-Boot Database Initialization (`RESET=true`)

### The Problem

On a **fresh postgres** (empty database, no tables), the Checkpoint framework crashes immediately because it tries to query the `_metadatas` table during initialization — before your code even runs.

```
Error: relation "_metadatas" does not exist
```

This happens because the `@snapshot-labs/checkpoint` constructor (in `index.ts` line 34) connects to postgres and queries internal tables at import time, **before** the `RESET` logic at line 110 gets a chance to run.

### The Solution: `RESET=true` on First Boot Only

```bash
# FIRST TIME ONLY — creates all schema tables:
RESET=true docker compose -f docker-compose.stage.yml -p checkpoint-stage up -d --force-recreate
```

This calls `checkpoint.reset()` which creates all required tables:

| Table | Purpose |
|---|---|
| `_metadatas` | Checkpoint framework internal (schema version tracking) |
| `_checkpoints` | Last indexed block per contract |
| `_blocks` | Block hash cache for reorg detection |
| `_template_sources` | Dynamic data source templates |
| `pools` | Pool entities (your data) |
| `proposals` | Proposal entities (your data) |
| `whitelistedtokens` | Token metadata (your data) |
| `candles` | OHLCV candle data (your data) |
| `swaps` | Individual swap records (your data) |

After the tables are created, **restart without RESET** so future restarts are safe:

```bash
# Normal restart (NO RESET — resumes from last block):
docker compose -f docker-compose.stage.yml -p checkpoint-stage up -d --force-recreate
```

### ⚠️ DANGER: Never Use `RESET=true` on a Running Indexer

> **`RESET=true` DELETES ALL DATA** — pools, swaps, candles, proposals, indexing progress. Everything.

It drops and recreates every table. This means:
- All indexed blocks are lost
- All pool volumes are wiped
- All candle history is gone
- The indexer starts from the very first block again (hours/days of re-indexing)

**When to use `RESET=true`:**
- ✅ First time starting with a fresh/empty database
- ✅ Intentional full re-index (e.g., after fixing a data bug like the volume fix)
- ✅ Schema change that adds/removes columns

**When NOT to use `RESET=true`:**
- ❌ Regular restarts (`docker compose restart` or `down`/`up`)
- ❌ Code changes that don't affect the schema
- ❌ RPC endpoint changes

### Safe Operations Reference

```bash
# ✅ SAFE — stops containers, keeps data volume, resumes on restart
docker compose down
docker compose up -d

# ✅ SAFE — restarts container, keeps all state
docker compose restart checkpoint

# ⚠️ DANGEROUS — deletes ALL postgres data (volume removed)
docker compose down -v

# ⚠️ DANGEROUS — wipes all tables and re-indexes from scratch
RESET=true docker compose up -d --force-recreate
```

The `docker-compose.yml` has `RESET: ${RESET:-false}` — it defaults to `false` so normal `docker compose up` never resets. Only an explicit `RESET=true` in the shell environment triggers it.

---

## Deploying a Staging Indexer (Without Disrupting Production)

### Why Staging?
After fixing code (e.g., the volume persistence fix), you need to re-index from scratch to rebuild correct pool volumes. But you can't take production down during re-indexing. The solution: spin up a **completely isolated** staging instance alongside production, let it fully sync, then switch the Charts API to point to it.

### Isolation Guarantee

The staging compose uses entirely separate resources — **no shared state** with production:

| Resource | Production | Staging |
|---|---|---|
| Compose project | `checkpoint` | `checkpoint-stage` |
| Checkpoint port | `3001` | `3004` |
| Postgres port | `5434` | `5436` |
| Database name | `checkpoint_candles` | `checkpoint_candles_stage` |
| Docker volume | `candles-postgres-data` | `candles-stage-postgres-data` |
| Docker network | `checkpoint-net` | `checkpoint-stage-net` |

> **No tables, volumes, or ports are shared. Production is untouched.**

### Step-by-Step

#### 1. Build and start staging (production stays running)
```bash
cd proposals-candles/checkpoint

# The -p flag sets the project name (critical for isolation!)
docker compose -f docker-compose.stage.yml -p checkpoint-stage up -d --build
```

#### 2. Monitor staging indexing progress
```bash
# Check logs
docker compose -f docker-compose.stage.yml -p checkpoint-stage logs -f checkpoint

# Check if it's serving data
curl -s http://localhost:3004/graphql -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ pools(first:1) { id volumeToken0 volumeToken1 } }"}' | jq
```

#### 3. Verify staging volumes are correct
```bash
# From repo root — compare staging vs Graph Node
# (edit test to use localhost:3004 for candles, or test manually)
curl -s http://localhost:3004/graphql -X POST \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ pools(where:{id:\"100-0x5ce6e5bb8866b30ffba342a9d988788a4011182f\"}) { volumeToken0 volumeToken1 } }"}' | jq
```

#### 4. Migrate Charts API to staging
Once staging is fully synced and verified:
```bash
# Option A: Change CANDLES_URL env var for futarchy-charts
export CANDLES_URL=http://localhost:3004/graphql

# Option B: Update the .env or process manager config
# Then restart futarchy-charts
```

#### 5. Decommission old production (only after Charts is pointing to staging)
```bash
# Stop OLD production containers
docker compose -f docker-compose.yml -p checkpoint down

# Optional: remove old volume to free disk space
docker volume rm checkpoint_candles-postgres-data
```

#### 6. Promote staging to production
Rename the staging compose or just leave it as is — it's now your new production. The Charts API already points to port 3004.

### Rollback
If staging has issues, switch Charts API back to the old endpoint:
```bash
export CANDLES_URL=http://localhost:3001/graphql
# Restart futarchy-charts
```
Production is still running on 3001 until you explicitly stop it.
