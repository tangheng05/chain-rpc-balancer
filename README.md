# chain-rpc-balancer

A health-aware HAProxy load balancer for blockchain JSON-RPC nodes. It's built for Graphene-style chains (steemd and its forks) but works with any node that reports a head block number and time.

## Why

A plain HAProxy `check` only opens a TCP connection. A node can still accept connections while it is:

- stuck on an old block,
- replaying or resyncing,
- slow enough to time out most requests.

HAProxy keeps sending traffic to that node, and some fraction of user requests fail.

Many of these nodes also return JSON-RPC errors **with HTTP 200**, so HAProxy can't spot a failing node from status codes either.

This project adds a small health agent that asks every node for its head block every few seconds. It tells HAProxy which nodes are actually in sync and responding.

## How it works

```
clients ──► HAProxy :80/:443
              │  checks each node through the agent (127.0.0.1:9101, 9102, ...)
              │                       │
              │                health agent ──── every 3s: get_dynamic_global_properties ───┐
              ▼                                                                             ▼
        node1 / node2 / node3 :8090  ◄──────────────────────────────────────────────────────┘
```

The agent marks a node **down** when any of these is true:

| Rule | Default |
| --- | --- |
| Request fails, times out, or returns non-2xx | `timeoutMs: 2000` |
| Response body contains a JSON-RPC `error` | always |
| Head block is older than N seconds | `maxBlockAgeSec: 30` |
| Node is more than N blocks behind the best node | `maxLagBlocks: 10` |

If **every** node's head block is stale, the chain itself has stopped. In that case the most up-to-date nodes stay in rotation, so reads keep working.

On the HAProxy side:

- **Rise/fall:** a node must pass 3 checks to come back and fail 2 to be removed. It ramps up over 30s (`slowstart`) after returning.
- **Passive checks:** `observe layer7` counts 5 consecutive 5xx responses or timeouts from a node as a failed health check and switches to 1s checks, so a failing node is removed within seconds.
- **Reads** go to `be_read`. A request that fails on one node (connection error, empty reply, 502/503/504) is retried on another node. Response timeouts are deliberately **not** retried: otherwise one very slow query would be replayed on every node and could knock them all out.
- **Broadcasts** are requests whose body contains `broadcast_transaction`. They go to `be_broadcast`, which retries only if the connection never opened. A broadcast that timed out may already have reached the network, so sending it again would produce a "duplicate transaction" error.
- **`/lb-health`** returns 503 when no node is up. Point uptime monitors or an upstream load balancer at it.

## Quick start

Requirements: Ubuntu 22.04+ (or any systemd distro), HAProxy 2.4+ (Ubuntu 22.04 ships 2.4), Node.js 18.17+.

```bash
git clone https://github.com/tangheng05/chain-rpc-balancer.git
cd chain-rpc-balancer
cp nodes.example.json nodes.json     # put your real nodes here; nodes.json is git-ignored
sudo STATS_PASSWORD='something-long' ./deploy/install.sh nodes.json
```

`install.sh` does the following:

1. Copies the app to `/opt/chain-rpc-balancer`.
2. Generates `/etc/haproxy/haproxy.cfg` and validates it with `haproxy -c`, keeping a backup of the old file.
3. Installs and starts the `chain-rpc-health` systemd service.
4. Reloads HAProxy.

To see what the agent currently thinks of each node:

```bash
curl -s 127.0.0.1:9100 | jq
```

```json
{
  "lastRunAt": 1767225600000,
  "nodes": [
    { "name": "node1", "headBlock": 1234567, "up": true, "reason": "up", "latencyMs": 41 },
    { "name": "node2", "headBlock": 1234540, "up": false, "reason": "27 blocks behind best node", "latencyMs": 38 }
  ]
}
```

## Configuration (`nodes.json`)

```json
{
  "agent":   { "host": "127.0.0.1", "statusPort": 9100, "basePort": 9101, "intervalMs": 3000 },
  "health":  { "timeoutMs": 2000, "maxBlockAgeSec": 30, "maxLagBlocks": 10 },
  "haproxy": {
    "bind": [":80", ":443 ssl crt /etc/haproxy/certs/site.pem"],
    "redirectHttps": true,
    "cors": true,
    "corsCredentials": false,
    "statsBind": "127.0.0.1:8404",
    "statsUser": "admin",
    "statsPassword": "change-me"
  },
  "nodes": [
    { "name": "node1", "host": "10.0.0.11", "port": 8090 }
  ]
}
```

All values are validated before anything is generated, and anything that could break or inject into `haproxy.cfg` (spaces, newlines, quotes, `#`) is rejected.

- Each node gets its own agent port, `basePort + index`. Set `checkPort` on a node to pick the port yourself.
- `STATS_PASSWORD` in the environment overrides `haproxy.statsPassword`.
- To terminate TLS on HAProxy, add a bind line such as `":443 ssl crt /etc/haproxy/certs/site.pem"`. Set `redirectHttps` to send plain HTTP to HTTPS (308, so POST bodies survive the redirect).
- `cors` (on by default) reflects the caller's `Origin` and answers `OPTIONS` preflights at the balancer, so browser dapps can call the API directly. Set `corsCredentials` only if browser clients send cookies or auth headers with `credentials: "include"`; with a reflected origin it lets any site make credentialed requests.
- `health.payload` sets the JSON-RPC request the agent sends. The default uses the legacy `call` API, which works on older steemd builds:

  ```json
  { "jsonrpc": "2.0", "id": 1, "method": "call", "params": ["database_api", "get_dynamic_global_properties", []] }
  ```

  On newer nodes you can use `condenser_api` instead:

  ```json
  { "jsonrpc": "2.0", "id": 1, "method": "condenser_api.get_dynamic_global_properties", "params": [] }
  ```

After you edit `nodes.json` on the server, run the installer again, or do it by hand:

```bash
sudo node /opt/chain-rpc-balancer/src/gen-haproxy.js /opt/chain-rpc-balancer/nodes.json > /tmp/haproxy.cfg
sudo haproxy -c -f /tmp/haproxy.cfg && sudo cp /tmp/haproxy.cfg /etc/haproxy/haproxy.cfg
sudo systemctl restart chain-rpc-health && sudo systemctl reload haproxy
```

## Hardening checklist

- [ ] Firewall each node's RPC port so only the load balancer's IP can reach it. Otherwise clients can bypass the balancer.
- [ ] Keep the stats page bound to `127.0.0.1` (the default) and open it through an SSH tunnel: `ssh -L 8404:127.0.0.1:8404 lb`.
- [ ] Set a long, random `STATS_PASSWORD`.
- [ ] If a CDN or reverse proxy sits in front, allow only its IP ranges on 80/443.
- [ ] Monitor `/lb-health` and the `chain-rpc-health` service. If the agent process dies, every check fails and HAProxy takes all nodes out; systemd restarts it within a second, but alert on it anyway. If the agent is running but its check loop stalls, it fails open (reports every node up, `"stale": true` in the status JSON) so the balancer keeps serving traffic instead of going dark.
- [ ] To remove the load balancer as a single point of failure, run two of them behind a floating IP with keepalived.

## Notes

- Runtime control: `echo "show servers state" | sudo socat stdio /run/haproxy/admin.sock`, or `set server be_read/node1 state maint` to drain a node by hand.
- WebSocket connections are supported (`timeout tunnel 1h`). Once a WebSocket is open, its messages aren't inspected, so broadcast routing and retries apply only to HTTP requests.
- HAProxy can only retry requests that fit in its buffer (16 KB by default). Very large request bodies are not retried.

## Development

```bash
npm test                                     # node:test, no dependencies
node src/gen-haproxy.js nodes.example.json   # print the generated config
node src/agent.js nodes.example.json         # run the agent locally
```

CI runs the tests on Node 18, 20, 22 and 24, validates the generated config with `haproxy -c` on HAProxy 2.4, 2.8, 3.0 and 3.2, and runs shellcheck on the installer.

## License

[MIT](LICENSE)
