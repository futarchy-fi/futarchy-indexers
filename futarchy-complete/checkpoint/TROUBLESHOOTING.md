# Futarchy Complete & Registry Indexer Troubleshooting

## 🚨 Severe Server Overload (Load Average > 20)

If the **Registry API `api.futarchy.fi/registry/graphql`** begins timing out (HTTP 502/504) or refusing connections (HTTP 000), the underlying `futarchy-registry-checkpoint` container is likely crash-looping due to CPU/RAM exhaustion on the host machine.

### The Symptoms
- `docker ps` shows the `futarchy-registry-checkpoint` container uptime constantly resetting (e.g. "Up 30 seconds" -> "Up 5 seconds").
- `docker logs futarchy-registry-checkpoint` hangs or returns nothing.
- `uptime` shows a load average significantly higher than the number of vCPUs (e.g. `37.7` on a 4-core machine).
- `free -h` shows RAM critically low (e.g., `< 500MiB` free) and no swap space.

### Why does it crash?
The Checkpoint indexer is tightly coupled to its PostgreSQL database. During extreme server load, disk I/O and CPU are starved. When the Checkpoint node app tries to open a transaction to save a block, Postgres does not respond in time. The connection times out, throwing an unhandled Promise Rejection, which causes the Node.js process to crash. Docker then restarts it, causing a crash-loop.

**Note:** The indexer fail-safe ensures that **no data is skipped or corrupted**. The process intentionally crashes rather than failing silently. When resources free up, it resumes exactly where the `_blocks` table left off.

---

## 🛠️ How to Fix the Outage

### 1. Diagnose the Load
Identify what is consuming the server's resources.
```bash
# Check overall load and memory
uptime && free -h

# Find the top CPU/RAM hogs
ps aux --sort=-%cpu | head -15
```
*Common culprits: Orphaned `find`/`grep` processes scanning the entire filesystem, excess `language_server`/IDE extensions, or multiple staging/prod Checkpoint environments running simultaneously.*

### 2. Free Up Resources
You must reduce the load before the Registry can successfully boot.
If you have multiple Checkpoint instances (like a Prod and Stage Candles indexer), temporarily turn one off.

```bash
# Example: Shutting down the Candles Staging environment to free ~2GB RAM
cd /home/ubuntu/futarchy-subgraphs/proposals-candles/checkpoint
docker compose -f docker-compose.stage.yml -p checkpoint-stage down
```
*(Do NOT use the `-v` flag to preserve all indexed database data.)*

### 3. Restart the Registry Indexer
Once `uptime` shows the load dropping (ideally < 10) and `free -h` shows > 1.5GB available RAM, bring the Registry back up.

```bash
cd /home/ubuntu/futarchy-subgraphs/futarchy-complete/checkpoint

# Restart the services
docker compose restart registry-checkpoint

# Verify it stays up (uptime should climb past 2 minutes)
docker ps --filter "name=registry-checkpoint"
```

### 4. Verify Recovery via GraphQL
Prove the database connection is restored and the indexer is actively processing blocks by querying its metadata.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"query":"{ _metadatas { id indexer value } organizations(first:1) { id } }"}' \
  http://localhost:3003/graphql | jq '.'
```
If this returns a JSON payload containing the `last_indexed_block` and an organization ID, the outage is resolved.

---

## 🚨 Indexer Infinite Loop / Rate Limit Masking

If the indexer (e.g. Candles or Registry) gets "stuck" at the tip and logs continuously print `ResourceNotFoundRpcError: Block not yet available on any RPC` in a tight loop, the `rpc_proxy.py` multiplexer might be swallowing HTTP limits (like `429 Too Many Requests`) and incorrectly returning block-not-found to the indexer library (`viem`).

### The Symptoms
- The block gap reported by `futarchy-status` stops decreasing or slowly grows.
- `docker logs <indexer-container>` is flooded with `Requested resource not found` for a specific block number.
- The logs repeat this thousands of times per minute.

### Why does it happen?
When upstream RPCs rate-limit the indexer (or return a 5xx error), `viem` should ideally intelligently back off. If a local RPC proxy masks these HTTP errors into a clean `null` or a `-32001 Block not found` JSON-RPC error, `viem` assumes the chain simply hasn't minted the block yet and furiously polls for it, effectively DoS-ing the proxy and downstream RPCs.

### How to Fix
Ensure `scripts/rpc_proxy.py` properly identifies HTTP failures vs. legitimate `null` block answers. It should return a `502` HTTP error if the upstream RPCs failed or were rate-limited, forcing `viem` to apply proper retry back-offs rather than infinite polling.
