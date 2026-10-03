#!/usr/bin/env bash
# Usage (as root, from the repo checkout): STATS_PASSWORD=... ./deploy/install.sh /path/to/nodes.json
set -euo pipefail

NODES_JSON="${1:?usage: install.sh /path/to/nodes.json}"
APP_DIR=/opt/chain-rpc-balancer
CFG=/etc/haproxy/haproxy.cfg

if [[ -z "${STATS_PASSWORD:-}" ]]; then
  echo "Set STATS_PASSWORD for the HAProxy stats page." >&2
  exit 1
fi

if ! command -v haproxy >/dev/null || ! command -v node >/dev/null; then
  apt-get update
  apt-get install -y haproxy nodejs
fi

node -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 18 || (maj === 18 && min >= 17) ? 0 : 1)' \
  || { echo "Node >= 18.17 is required" >&2; exit 1; }

mkdir -p "$APP_DIR"
cp -r src templates package.json "$APP_DIR/"
install -m 0644 "$NODES_JSON" "$APP_DIR/nodes.json"

TMP_CFG="$(mktemp)"
node "$APP_DIR/src/gen-haproxy.js" "$APP_DIR/nodes.json" > "$TMP_CFG"
haproxy -c -f "$TMP_CFG"

install -m 0644 deploy/chain-rpc-health.service /etc/systemd/system/chain-rpc-health.service
systemctl daemon-reload
systemctl enable --now chain-rpc-health
systemctl restart chain-rpc-health

[[ -f "$CFG" ]] && cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"
install -m 0640 -g haproxy "$TMP_CFG" "$CFG"
rm -f "$TMP_CFG"

systemctl enable haproxy
systemctl reload haproxy || systemctl restart haproxy

sleep 4
curl -s "http://127.0.0.1:$(node -p 'require("'"$APP_DIR"'/src/config").loadConfig("'"$APP_DIR"'/nodes.json").agent.statusPort')/"
