# RPC proxy (reorg-loop-safe)

Multi-RPC pool with tip buffer, failover, and **reorg-safe hash pinning** that
sits between the checkpoint indexers and free Gnosis/Mainnet RPCs.

Deployed on the indexer VM at `/opt/futarchy-rpc-proxy/rpc_proxy.py`, run by the
systemd unit `rpc-proxy.service` (see `rpc-proxy.service` here). Indexer
containers reach it at `http://172.17.0.1:8545` (gnosis) / `:8546` (mainnet).

## Why hash pinning is gated by confirmation depth

A genuine reorg near the tip makes upstreams briefly disagree on a block hash.
The original pin cached the FIRST-seen hash by block number with no consensus
check AND re-extended its TTL on every refetch — so a transient bad hash got
pinned forever, and the indexer's reorg detector oscillated between two adjacent
blocks indefinitely (the "reorg-loop wedge").

Two changes make pinning safe:

1. **`HashPinCache.set` never re-extends a live pin.** A bad pin now expires on
   schedule (`RPC_PROXY_HASH_PIN_TTL`, default 30s), letting upstreams reconverge.
2. **Near-tip blocks are never pinned and never served from cache.** Blocks
   within `RPC_PROXY_PIN_CONFIRMATIONS` (default 200) of the last-seen tip — the
   only place upstreams disagree — always get a live read. Below that depth the
   canonical hash is stable, so pinning still breaks any transient alternation.

This still lets the indexer detect and handle a real reorg: it reads fresh
near-tip hashes, sees a genuine parentHash mismatch once, rewinds, and advances.

## Deploy / update

```bash
gcloud compute ssh futarchy-indexers --project futarchy-prod --zone europe-north1-a
# copy this rpc_proxy.py to /opt/futarchy-rpc-proxy/rpc_proxy.py, then:
sudo systemctl restart rpc-proxy.service
curl -s localhost:8545/stats   # shows pin_confirmations, last_tip, hash_pin entries
```

Tunables (systemd `Environment=` or `/etc/futarchy-rpc-proxy.env`):
`RPC_PROXY_TIP_BUFFER_GNOSIS`, `RPC_PROXY_HASH_PIN_TTL`,
`RPC_PROXY_PIN_CONFIRMATIONS`, `RPC_PROXY_REQUEST_TIMEOUT`,
`GNOSIS_QUICKNODE_RPC_URL`, `MAINNET_INFURA_RPC_URL`.
