# Checkpoint Indexers — Operations Guide

## Architecture: File-Based RPC Switching

Both indexers (registry + candles) read RPCs from a **shared config file** mounted as a Docker volume.
This enables RPC switching via `docker restart` with **ZERO blocks lost**.

```
/home/ubuntu/futarchy-subgraphs/rpc-config.json  ← Edit this file
        │
        ├── Mounted into candles container  at /app/rpc-config.json
        └── Mounted into registry container at /app/rpc-config.json
```

### Config File Format
```json
{
  "active": "fast",           ← Watchdog flips this
  "fast": {
    "gnosis_rpc": "https://paid-quicknode-url...",
    "mainnet_rpc": "https://paid-infura-url..."
  },
  "free": {
    "gnosis_rpc": "https://rpc.gnosischain.com",
    "mainnet_rpc": "https://eth.llamarpc.com"
  }
}
```

---

## 🔄 Switching RPCs (Zero Downtime)

### Automatic (Watchdog)
The watchdog (`scripts/checkpoint-watchdog.sh`) handles this automatically:
- **Gap > 1000 blocks** → Switches to `"fast"` + `docker restart`
- **Gap < 100 blocks** → Switches to `"free"` + `docker restart`
- State is **100% preserved** — `docker restart` never destroys in-memory data

### Manual
```bash
# Switch to fast
python3 -c "
import json
with open('/home/ubuntu/futarchy-subgraphs/rpc-config.json', 'r+') as f:
    c = json.load(f); c['active'] = 'fast'; f.seek(0); json.dump(c, f, indent=2); f.truncate()
"
docker restart checkpoint-checkpoint-1 futarchy-registry-checkpoint

# Switch to free
python3 -c "
import json
with open('/home/ubuntu/futarchy-subgraphs/rpc-config.json', 'r+') as f:
    c = json.load(f); c['active'] = 'free'; f.seek(0); json.dump(c, f, indent=2); f.truncate()
"
docker restart checkpoint-checkpoint-1 futarchy-registry-checkpoint
```

---

## ⚠️ Critical Rules

| Action | State Loss | Safe? |
|--------|-----------|-------|
| `docker restart` | **0 blocks** | ✅ Always safe |
| Edit rpc-config.json + `docker restart` | **0 blocks** | ✅ Safe (this is the new RPC switching) |
| `docker compose down/up` (same image) | **~700K blocks** | ⚠️ Only for code deploys |
| `docker compose down/up` + `RESET=true` | **ALL blocks** | ❌ Only if data corrupted |

---

## 🛡️ Watchdog

Runs every 5 minutes via cron. Actions:

1. **Stuck detection**: If no block progress for 2 checks (10 min) → `docker restart`
2. **RPC switching**: Edits `rpc-config.json` "active" field + `docker restart`

**It NEVER does `docker compose down/up`.**

---

## 📊 Monitoring

```bash
# Check current blocks
curl -sf -H "Content-Type: application/json" \
  -d '{"query":"{ _metadatas(where: { id: \"last_indexed_block\" }) { value } }"}' \
  http://localhost:3001/graphql | python3 -m json.tool

# Check active RPC
cat /home/ubuntu/futarchy-subgraphs/rpc-config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['active'])"

# Watchdog logs
tail -20 /home/ubuntu/checkpoint-watchdog.log

# Status page
# https://status.futarchy.fi
```
