#!/usr/bin/env bash
# Usage (as root): STATS_PASSWORD=... ./deploy/install.sh /path/to/nodes.json
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: STATS_PASSWORD=... $0 /path/to/nodes.json" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi
if [[ -z "${STATS_PASSWORD:-}" ]]; then
  echo "Set STATS_PASSWORD for the HAProxy stats page." >&2
  exit 1
fi

NODES_JSON="$(realpath "$1")"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/chain-rpc-balancer
CFG=/etc/haproxy/haproxy.cfg

if ! command -v haproxy >/dev/null || ! command -v node >/dev/null; then
  apt-get update
  apt-get install -y haproxy nodejs
fi

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 18 || (a === 18 && b >= 17) ? 0 : 1)'; then
  echo "Node.js >= 18.17 is required (see https://github.com/nodesource/distributions)." >&2
  exit 1
fi

mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/templates"
cp -r "$REPO_DIR/src" "$REPO_DIR/templates" "$REPO_DIR/package.json" "$APP_DIR/"
install -m 0644 "$NODES_JSON" "$APP_DIR/nodes.json"

TMP_CFG="$(mktemp)"
trap 'rm -f "$TMP_CFG"' EXIT
node "$APP_DIR/src/gen-haproxy.js" "$APP_DIR/nodes.json" > "$TMP_CFG"
haproxy -c -f "$TMP_CFG"

install -m 0644 "$REPO_DIR/deploy/chain-rpc-health.service" /etc/systemd/system/chain-rpc-health.service
systemctl daemon-reload
systemctl enable chain-rpc-health
systemctl restart chain-rpc-health

if [[ -f "$CFG" ]]; then
  cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"
fi
install -m 0640 -o root -g haproxy "$TMP_CFG" "$CFG"

systemctl enable haproxy
systemctl reload haproxy || systemctl restart haproxy

STATUS_PORT="$(node -p 'require(process.argv[1]).loadConfig(process.argv[2]).agent.statusPort' "$APP_DIR/src/config.js" "$APP_DIR/nodes.json")"
sleep 4
curl -fsS "http://127.0.0.1:$STATUS_PORT/" || echo "Agent status not reachable yet; check: journalctl -u chain-rpc-health" >&2
