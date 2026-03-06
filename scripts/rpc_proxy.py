#!/usr/bin/env python3
"""
RPC Proxy — multi-RPC pool with tip buffer and failover.

Sits between checkpoint indexers and upstream RPCs. Solves:
  - BlockNotFoundError (tip buffer: returns eth_blockNumber - N)
  - Single-RPC dependency (failover across pool)
  - QuikNode is just one more RPC in the pool

Each chain gets its own port. Containers point to http://localhost:PORT.
"""

import json
import os
import sys
import time
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Tip buffer: how many blocks behind the real tip to report.
# Prevents BlockNotFoundError from load-balanced RPCs.
TIP_BUFFER = {
    "gnosis": 40,   # 40 blocks × 5s = 200s delay
    "mainnet": 30,   # 30 blocks × 12s = 360s delay
}

# Methods where a null result means "not found" — failover to next RPC.
NULL_RESULT_FAILOVER_METHODS = {
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
}

GNOSIS_QUICKNODE_RPC_URL = os.environ.get("GNOSIS_QUICKNODE_RPC_URL", "").strip()
MAINNET_INFURA_RPC_URL = os.environ.get("MAINNET_INFURA_RPC_URL", "").strip()

CHAINS = {
    "gnosis": {
        "port": 8545,
        "rpcs": [
            {"name": "Gnosis Official", "url": "https://rpc.gnosischain.com"},
            {"name": "PublicNode",      "url": "https://gnosis-rpc.publicnode.com"},
            {"name": "1RPC",            "url": "https://1rpc.io/gnosis"},
        ],
    },
    "mainnet": {
        "port": 8546,
        "rpcs": [
            {"name": "Infura",     "url": "https://mainnet.infura.io/v3/93d87aec412249038b1953dda02fd760"},
            {"name": "PublicNode", "url": "https://ethereum-rpc.publicnode.com"},
            {"name": "1RPC",       "url": "https://1rpc.io/eth"},
        ],
    },
}

if GNOSIS_QUICKNODE_RPC_URL:
    CHAINS["gnosis"]["rpcs"].append({"name": "QuikNode", "url": GNOSIS_QUICKNODE_RPC_URL})

REQUEST_TIMEOUT = 15  # seconds


# ---------------------------------------------------------------------------
# RPC Proxy Handler
# ---------------------------------------------------------------------------

class RPCProxyHandler(BaseHTTPRequestHandler):
    """Handles JSON-RPC requests by proxying to upstream RPCs with failover."""

    chain_name = None
    rpc_pool = None
    tip_buffer = 0

    def log_message(self, format, *args):
        # Quieter logging — only errors
        pass

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        method = request.get("method", "")
        response_body = None
        last_error = None
        succeeded = False

        for rpc in self.rpc_pool:
            try:
                response_body = self._forward(rpc["url"], body)

                # Apply tip buffer for eth_blockNumber
                if method == "eth_blockNumber" and self.tip_buffer > 0:
                    resp = json.loads(response_body)
                    if "result" in resp and resp["result"]:
                        real_block = int(resp["result"], 16)
                        buffered = max(0, real_block - self.tip_buffer)
                        resp["result"] = hex(buffered)
                        response_body = json.dumps(resp).encode()

                # Failover on null/incomplete result for getBlock
                if method in NULL_RESULT_FAILOVER_METHODS:
                    resp = json.loads(response_body)
                    result = resp.get("result")
                    if result is None:
                        last_error = f"{rpc['name']}: null result for {method}"
                        continue
                    # Also failover if block returned without hash (e.g. pending block)
                    if isinstance(result, dict) and result.get("hash") is None:
                        last_error = f"{rpc['name']}: block with null hash for {method}"
                        print(f"[{self.chain_name}] WARN: {rpc['name']} returned block without hash", file=sys.stderr)
                        continue

                succeeded = True
                break  # Success — stop trying other RPCs

            except Exception as e:
                last_error = f"{rpc['name']}: {e}"
                continue

        # All RPCs returned null for a block-fetch method — return JSON-RPC error
        # instead of null result, so viem throws a retryable error (not BlockNotFoundError
        # which can poison the checkpoint framework's block cache).
        if not succeeded and method in NULL_RESULT_FAILOVER_METHODS:
            print(f"[{self.chain_name}] Block failover exhausted. Last error: {last_error}", file=sys.stderr)
            
            # If the last error was actually an HTTP error/exception rather than a clean null,
            # we should surface a general failure rather than a block not found error
            # so the indexer backs off instead of treating it as a chain tip issue.
            is_real_null = last_error and "null result for" in last_error
            if not is_real_null:
                error_resp = json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "error": {"code": -32000, "message": f"All RPCs failed or rate limited. Last: {last_error}"}
                }).encode()
                self.send_response(502)
            else:
                error_resp = json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "error": {"code": -32001, "message": "Block not yet available on any RPC"}
                }).encode()
                self.send_response(200)

            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(error_resp)))
            self.end_headers()
            self.wfile.write(error_resp)
            return

        if response_body is None:
            error_resp = json.dumps({
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -32000, "message": f"All RPCs failed. Last: {last_error}"}
            }).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(error_resp)))
            self.end_headers()
            self.wfile.write(error_resp)
            print(f"[{self.chain_name}] ALL FAILED for {method}: {last_error}", file=sys.stderr)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def _forward(self, url, body):
        """Forward a request to an upstream RPC. Returns response bytes or raises."""
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "FutarchyRPCProxy/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = resp.read()
            # Check for JSON-RPC error that indicates a real problem (not app-level)
            try:
                parsed = json.loads(data)
                if "error" in parsed and parsed["error"]:
                    msg = parsed["error"].get("message", "")
                    # Only failover on infrastructure errors, not app-level errors
                    if any(x in msg.lower() for x in ["too large", "limit", "rate"]):
                        raise RuntimeError(f"RPC rejected: {msg}")
            except json.JSONDecodeError:
                raise RuntimeError("Invalid JSON response")
            return data


def run_chain_proxy(chain_name, config):
    """Start HTTP server for one chain."""
    port = config["port"]
    rpcs = config["rpcs"]
    buffer = TIP_BUFFER.get(chain_name, 10)

    class Handler(RPCProxyHandler):
        pass
    Handler.chain_name = chain_name
    Handler.rpc_pool = rpcs
    Handler.tip_buffer = buffer

    class ReuseServer(HTTPServer):
        allow_reuse_address = True

    server = ReuseServer(("0.0.0.0", port), Handler)
    print(f"[{chain_name}] Proxy listening on 127.0.0.1:{port} "
          f"(pool: {len(rpcs)} RPCs, tip buffer: {buffer} blocks)")
    server.serve_forever()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    chain_filter = sys.argv[1] if len(sys.argv) > 1 else None

    threads = []
    for chain_name, config in CHAINS.items():
        if chain_filter and chain_name != chain_filter:
            continue
        t = threading.Thread(target=run_chain_proxy, args=(chain_name, config), daemon=True)
        t.start()
        threads.append(t)

    if not threads:
        print(f"No chains matched filter '{chain_filter}'", file=sys.stderr)
        sys.exit(1)

    print(f"RPC Proxy running ({len(threads)} chains)")
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
