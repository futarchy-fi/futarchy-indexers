#!/usr/bin/env python3
"""
RPC Proxy — multi-RPC pool with tip buffer, failover, and hash pinning.

Sits between the futarchy checkpoint indexers and free upstream RPCs.
Solves three classes of failure that come from running on a pool of
free, load-balanced public endpoints:

  1. BlockNotFoundError at the chain tip
       Different upstreams sit at slightly different head heights.
       Subtracts a per-chain TIP_BUFFER from `eth_blockNumber` so the
       indexer never asks for a block that hasn't propagated everywhere.

  2. Single-RPC dependency
       Iterates a fixed-order pool on every request. If the first RPC
       times out, errors, or returns a clear "too large / rate limit"
       JSON-RPC error, falls over to the next.

  3. Reorg-loop bug ("RPC confusion")
       At the tip-edge, two upstreams can briefly disagree on the hash
       for the same block (one saw an uncle the others rejected).
       Without protection the indexer alternates seeing X then Y for
       the same block height, and its reorg detector loops forever.
       Hash pinning caches `eth_getBlockByNumber` / `eth_getBlockByHash`
       responses for HASH_PIN_TTL seconds — so the proxy returns the
       SAME hash for a given block regardless of which upstream is
       polled next, breaking the alternation. After the TTL the cache
       refetches; by then upstreams have converged on the canonical
       chain, so the indexer detects ONE legitimate reorg (if any),
       rewinds correctly, and advances.

Each chain runs on its own port. Containers point to
http://172.17.0.1:PORT (the docker bridge gateway IP from inside the
container) when the proxy is on the same host.

Configuration is via environment variables:
  - GNOSIS_QUICKNODE_RPC_URL  optional paid Gnosis RPC, prepended to pool
  - MAINNET_INFURA_RPC_URL    optional paid Mainnet RPC, prepended to pool
  - RPC_PROXY_TIP_BUFFER_GNOSIS  override tip buffer for Gnosis (default 20)
  - RPC_PROXY_TIP_BUFFER_MAINNET override tip buffer for Mainnet (default 5)
  - RPC_PROXY_HASH_PIN_TTL    seconds to pin block hashes (default 30)
  - RPC_PROXY_REQUEST_TIMEOUT seconds per upstream call (default 15)
"""

import json
import os
import sys
import time
import threading
import urllib.request
import urllib.error
from collections import OrderedDict
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any, ClassVar, List, Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TIP_BUFFER = {
    "gnosis":  int(os.environ.get("RPC_PROXY_TIP_BUFFER_GNOSIS",  "50")),
    "mainnet": int(os.environ.get("RPC_PROXY_TIP_BUFFER_MAINNET", "5")),
}

HASH_PIN_TTL = int(os.environ.get("RPC_PROXY_HASH_PIN_TTL", "30"))
HASH_PIN_MAX_ENTRIES = 10_000  # bound memory; LRU evicts beyond this
REQUEST_TIMEOUT = int(os.environ.get("RPC_PROXY_REQUEST_TIMEOUT", "15"))

# Confirmation depth for pinning. Blocks within this many of the live tip are
# NOT pinned: that is exactly where upstreams disagree on hashes, and pinning
# the first-seen (possibly wrong) hash there is what immortalises a reorg loop.
# Below the tip - PIN_CONFIRMATIONS the canonical hash is stable, so pinning is
# safe and still breaks any transient alternation. Default 200 >> Gnosis
# propagation spread (<~tens of blocks).
PIN_CONFIRMATIONS = int(os.environ.get("RPC_PROXY_PIN_CONFIRMATIONS", "200"))

GNOSIS_QUICKNODE_RPC_URL = os.environ.get("GNOSIS_QUICKNODE_RPC_URL", "").strip()
MAINNET_INFURA_RPC_URL   = os.environ.get("MAINNET_INFURA_RPC_URL", "").strip()

CHAINS = {
    "gnosis": {
        "port": 8545,
        "rpcs": [
            {"name": "Gnosis Official", "url": "https://rpc.gnosischain.com"},
            {"name": "PublicNode",      "url": "https://gnosis-rpc.publicnode.com"},
            {"name": "dRPC",            "url": "https://gnosis.drpc.org"},
        ],
    },
    "mainnet": {
        "port": 8546,
        "rpcs": [
            {"name": "PublicNode", "url": "https://ethereum-rpc.publicnode.com"},
            {"name": "1RPC",       "url": "https://1rpc.io/eth"},
            {"name": "Llama",      "url": "https://eth.llamarpc.com"},
        ],
    },
}

# Paid RPCs (if configured) get priority — prepend to pool
if GNOSIS_QUICKNODE_RPC_URL:
    CHAINS["gnosis"]["rpcs"].insert(0, {"name": "QuikNode (paid)", "url": GNOSIS_QUICKNODE_RPC_URL})
if MAINNET_INFURA_RPC_URL:
    CHAINS["mainnet"]["rpcs"].insert(0, {"name": "Infura (paid)", "url": MAINNET_INFURA_RPC_URL})

# Methods whose response we hash-pin. Block lookups by number/hash —
# these are the ones whose inconsistency causes reorg loops.
PINNABLE_METHODS = frozenset({
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
})

# Methods that we treat null result as a transient miss to fail over on.
# A free RPC returning null for a recent block usually means it hasn't
# synced that block yet — try the next upstream.
NULL_RESULT_FAILOVER_METHODS = frozenset({
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
})

# Substrings in JSON-RPC error messages that mean "this upstream can't
# serve this request — try another." NOT app-level errors that should
# propagate (revert reasons, gas too low, etc.).
INFRA_ERROR_SUBSTRINGS = (
    "too large", "limit", "rate", "throttl", "timeout",
    "request entity", "payload too", "exceeded",
)


# ---------------------------------------------------------------------------
# Hash pin cache: TTL + LRU bound
# ---------------------------------------------------------------------------

class HashPinCache:
    """Per-chain TTL+LRU cache for pinnable block-lookup responses."""

    def __init__(self, ttl_seconds, max_entries):
        self.ttl = ttl_seconds
        self.max = max_entries
        self.lock = threading.Lock()
        self.entries = OrderedDict()  # key -> (expires_at, response_bytes)

    def get(self, key):
        now = time.time()
        with self.lock:
            entry = self.entries.get(key)
            if entry is None:
                return None
            expires_at, payload = entry
            if expires_at < now:
                self.entries.pop(key, None)
                return None
            self.entries.move_to_end(key)
            return payload

    def set(self, key, payload):
        now = time.time()
        with self.lock:
            existing = self.entries.get(key)
            if existing is not None and existing[0] > now:
                # Do NOT re-extend a live pin. Re-extending on every refetch is
                # what let a transient bad-hash pin outlive the indexer's reorg
                # retry cycle forever. Keep the original expiry so the pin
                # eventually clears and upstreams get a chance to reconverge.
                self.entries.move_to_end(key)
                return
            self.entries[key] = (now + self.ttl, payload)
            self.entries.move_to_end(key)
            while len(self.entries) > self.max:
                self.entries.popitem(last=False)

    def stats(self):
        with self.lock:
            return {"entries": len(self.entries), "ttl": self.ttl, "max": self.max}


def pin_key_for_request(request):
    """Stable cache key for a pinnable RPC request. Returns None if not pinnable."""
    method = request.get("method")
    if method not in PINNABLE_METHODS:
        return None
    params = request.get("params") or []
    if method == "eth_getBlockByNumber":
        if len(params) < 2:
            return None
        block_arg = params[0]
        # Don't pin "latest"/"pending"/"earliest" — caller wants liveness
        if not isinstance(block_arg, str) or not block_arg.startswith("0x"):
            return None
        return ("eth_getBlockByNumber", block_arg.lower(), bool(params[1]))
    if method == "eth_getBlockByHash":
        if len(params) < 2:
            return None
        return ("eth_getBlockByHash", str(params[0]).lower(), bool(params[1]))
    return None


def rewrite_response_id(response_bytes, request_id):
    """Pinned responses were stored under a different request id. Replace it
    so the JSON-RPC client correlates the response to its current request."""
    try:
        data = json.loads(response_bytes)
    except (json.JSONDecodeError, ValueError):
        return response_bytes
    if isinstance(data, dict) and "id" in data:
        data["id"] = request_id
        return json.dumps(data).encode()
    return response_bytes


# ---------------------------------------------------------------------------
# Upstream call with failover
# ---------------------------------------------------------------------------

def call_upstream(url, body):
    """POST body to url. Returns (status, response_bytes, error_str)."""
    req = urllib.request.Request(
        url, data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "FutarchyRPCProxy/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return ("ok", resp.read(), None)
    except urllib.error.HTTPError as e:
        try:
            body = e.read()
        except Exception:
            body = b""
        return ("http_error", body, f"HTTP {e.code}")
    except urllib.error.URLError as e:
        return ("network_error", b"", f"URLError: {e.reason}")
    except (TimeoutError, ConnectionError) as e:
        return ("network_error", b"", f"timeout: {e}")
    except Exception as e:  # noqa: BLE001
        return ("network_error", b"", f"{type(e).__name__}: {e}")


def upstream_response_is_failover_worthy(method, response_bytes):
    """Return (failover, reason). True means try the next upstream."""
    try:
        parsed = json.loads(response_bytes)
    except (json.JSONDecodeError, ValueError):
        return (True, "non-JSON response")

    if isinstance(parsed, list):
        return (False, None)  # batched — let the caller see it

    err = parsed.get("error")
    if err:
        msg = (err.get("message") or "").lower()
        if any(sub in msg for sub in INFRA_ERROR_SUBSTRINGS):
            return (True, f"infra error: {msg[:120]}")
        return (False, None)  # app-level error, propagate

    if method in NULL_RESULT_FAILOVER_METHODS:
        result = parsed.get("result")
        if result is None:
            return (True, "null result")
        # Block returned but with null hash → also fail over
        if isinstance(result, dict) and result.get("hash") is None:
            return (True, "block returned with null hash")

    return (False, None)


# ---------------------------------------------------------------------------
# HTTP handler per chain
# ---------------------------------------------------------------------------

class RPCProxyHandler(BaseHTTPRequestHandler):
    chain_name: ClassVar[str] = ""
    rpc_pool: ClassVar[List[dict]] = []
    tip_buffer: ClassVar[int] = 0
    cache: ClassVar[Optional["HashPinCache"]] = None
    # Last real (unbuffered) tip height seen from an eth_blockNumber response.
    # Shared across the chain's handler instances; used to refuse pinning
    # near-tip blocks where upstreams disagree on hashes.
    last_tip: ClassVar[int] = 0
    tip_lock: ClassVar[threading.Lock] = threading.Lock()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # Quiet — write only via explicit print on errors
        del format, args

    def _note_tip(self, real_height: int) -> None:
        cls = type(self)
        with cls.tip_lock:
            if real_height > cls.last_tip:
                cls.last_tip = real_height

    def _is_near_tip(self, pin_key) -> bool:
        """True if pin_key refers to an eth_getBlockByNumber at a hex height
        within PIN_CONFIRMATIONS of the last-seen tip. Such blocks must not be
        pinned (that is where upstreams disagree and reorg loops are born)."""
        cls = type(self)
        if cls.last_tip <= 0:
            return False
        try:
            if pin_key[0] != "eth_getBlockByNumber":
                return False
            height = int(pin_key[1], 16)
        except (TypeError, ValueError, IndexError):
            return False
        return (cls.last_tip - height) <= PIN_CONFIRMATIONS

    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler convention)
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""
        except Exception as e:  # noqa: BLE001
            self._send_error(400, f"bad request body: {e}")
            return

        try:
            request = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._send_error(400, "invalid JSON")
            return

        if isinstance(request, list):
            # Batched: we don't pin or buffer-tip individual entries here.
            # Forward to the first upstream that answers without infra error.
            self._forward_batch(body, request)
            return

        method = request.get("method", "")
        request_id = request.get("id")

        # Check the hash pin cache first. Skip the cache for near-tip blocks so
        # the indexer always gets a live read there and a stale near-tip pin can
        # never be served back into a reorg loop.
        pin_key = pin_key_for_request(request)
        if pin_key is not None and self.cache is not None and not self._is_near_tip(pin_key):
            cached = self.cache.get(pin_key)
            if cached is not None:
                self._send_payload(rewrite_response_id(cached, request_id))
                return

        # Walk the upstream pool until one answers cleanly.
        last_error = None
        for rpc in self.rpc_pool:
            status, payload, err = call_upstream(rpc["url"], body)
            if status != "ok":
                last_error = f"{rpc['name']}: {err}"
                continue
            failover, reason = upstream_response_is_failover_worthy(method, payload)
            if failover:
                last_error = f"{rpc['name']}: {reason}"
                continue

            # Record the real tip (before buffering) so we can refuse to pin
            # near-tip blocks, then apply the tip buffer for eth_blockNumber.
            if method == "eth_blockNumber":
                try:
                    parsed_bn = json.loads(payload)
                    if isinstance(parsed_bn, dict) and parsed_bn.get("result"):
                        self._note_tip(int(parsed_bn["result"], 16))
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
                if self.tip_buffer > 0:
                    payload = self._apply_tip_buffer(payload)

            # Pin block-lookup responses — but ONLY for blocks safely below the
            # tip. Near-tip blocks are where upstreams disagree; pinning the
            # first-seen hash there is the root cause of the reorg loop.
            if pin_key is not None and self.cache is not None and not self._is_near_tip(pin_key):
                self.cache.set(pin_key, payload)

            self._send_payload(payload)
            return

        # All upstreams failed.
        err_resp = {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32000,
                "message": f"All upstreams failed. Last: {last_error}",
            },
        }
        self._send_payload(json.dumps(err_resp).encode(), status=502)
        print(f"[{self.chain_name}] ALL FAILED for {method}: {last_error}",
              file=sys.stderr, flush=True)

    def do_GET(self):  # noqa: N802
        # Tiny health/stats endpoint
        if self.path == "/health":
            self._send_payload(b'{"status":"ok"}')
            return
        if self.path == "/stats":
            payload = json.dumps({
                "chain": self.chain_name,
                "rpc_pool": [r["name"] for r in self.rpc_pool],
                "tip_buffer": self.tip_buffer,
                "pin_confirmations": PIN_CONFIRMATIONS,
                "last_tip": type(self).last_tip,
                "hash_pin": self.cache.stats() if self.cache else None,
            }).encode()
            self._send_payload(payload)
            return
        self._send_error(404, "not found")

    def _forward_batch(self, body, _request_list):
        last_error = None
        for rpc in self.rpc_pool:
            status, payload, err = call_upstream(rpc["url"], body)
            if status == "ok":
                self._send_payload(payload)
                return
            last_error = f"{rpc['name']}: {err}"
        self._send_payload(
            json.dumps({"error": f"All upstreams failed. Last: {last_error}"}).encode(),
            status=502,
        )

    def _apply_tip_buffer(self, payload):
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            return payload
        if not isinstance(data, dict) or "result" not in data or not data["result"]:
            return payload
        try:
            real = int(data["result"], 16)
        except (TypeError, ValueError):
            return payload
        buffered = max(0, real - self.tip_buffer)
        data["result"] = hex(buffered)
        return json.dumps(data).encode()

    def _send_payload(self, payload, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_error(self, status, message):
        payload = json.dumps({"error": message}).encode()
        self._send_payload(payload, status=status)


# ---------------------------------------------------------------------------
# Per-chain server
# ---------------------------------------------------------------------------

def run_chain_proxy(chain_name, config):
    cache = HashPinCache(HASH_PIN_TTL, HASH_PIN_MAX_ENTRIES) if HASH_PIN_TTL > 0 else None

    class Handler(RPCProxyHandler):
        pass
    Handler.chain_name = chain_name
    Handler.rpc_pool = config["rpcs"]
    Handler.tip_buffer = TIP_BUFFER.get(chain_name, 10)
    Handler.cache = cache

    server = HTTPServer(("0.0.0.0", config["port"]), Handler)
    print(
        f"[{chain_name}] listening on 0.0.0.0:{config['port']} "
        f"(pool: {len(config['rpcs'])} RPCs, tip_buffer: {Handler.tip_buffer}, "
        f"hash_pin_ttl: {HASH_PIN_TTL}s)",
        flush=True,
    )
    for rpc in config["rpcs"]:
        print(f"  - {rpc['name']}: {rpc['url']}", flush=True)
    server.serve_forever()


def main():
    chain_filter = sys.argv[1] if len(sys.argv) > 1 else None
    threads = []
    for name, config in CHAINS.items():
        if chain_filter and name != chain_filter:
            continue
        t = threading.Thread(target=run_chain_proxy, args=(name, config), daemon=True)
        t.start()
        threads.append(t)
    if not threads:
        print(f"No chains matched filter '{chain_filter}'", file=sys.stderr)
        sys.exit(1)
    print(f"RPC proxy running ({len(threads)} chains)", flush=True)
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("shutting down")


if __name__ == "__main__":
    main()
