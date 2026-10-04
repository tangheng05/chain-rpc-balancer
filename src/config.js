const fs = require('node:fs');

const DEFAULTS = {
  agent: { host: '127.0.0.1', statusPort: 9100, basePort: 9101, intervalMs: 3000 },
  health: {
    timeoutMs: 2000,
    maxBlockAgeSec: 30,
    maxLagBlocks: 10,
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'call',
      params: ['database_api', 'get_dynamic_global_properties', []],
    },
  },
  haproxy: {
    bind: [':80'],
    redirectHttps: false,
    cors: true,
    corsCredentials: false,
    statsBind: '127.0.0.1:8404',
    statsUser: 'admin',
    statsPassword: 'change-me',
    statusPath: null,
    statusToken: null,
    maxConnPerNode: null,
    clientIpHeader: null,
    logBodyBytes: 0,
    maxHistoryLimit: null,
  },
};

const NAME = /^[A-Za-z0-9_.-]+$/;
const URL_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const HEADER = /^[A-Za-z0-9-]+$/;
const HOST = /^[A-Za-z0-9.:[\]-]+$/;
// Values are written straight into haproxy.cfg, so no whitespace, comments or quotes.
const CFG_TOKEN = /^[^\s#"'\\]+$/;

function fail(msg) {
  throw new Error(`config: ${msg}`);
}

function checkPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`${label} must be a port number`);
}

function checkPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number`);
}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    fail('"nodes" must be a non-empty array');
  }
  const agent = { ...DEFAULTS.agent, ...raw.agent };
  const health = { ...DEFAULTS.health, ...raw.health };
  const haproxy = { ...DEFAULTS.haproxy, ...raw.haproxy };
  if (typeof haproxy.bind === 'string') haproxy.bind = [haproxy.bind];

  if (!HOST.test(agent.host)) fail('agent.host is not a valid address');
  checkPort(agent.statusPort, 'agent.statusPort');
  checkPort(agent.basePort, 'agent.basePort');
  checkPositive(agent.intervalMs, 'agent.intervalMs');
  checkPositive(health.timeoutMs, 'health.timeoutMs');
  checkPositive(health.maxBlockAgeSec, 'health.maxBlockAgeSec');
  if (!Number.isInteger(health.maxLagBlocks) || health.maxLagBlocks < 0) {
    fail('health.maxLagBlocks must be a non-negative integer');
  }
  if (!health.payload || typeof health.payload !== 'object') fail('health.payload must be an object');

  if (!Array.isArray(haproxy.bind) || haproxy.bind.length === 0) fail('haproxy.bind must not be empty');
  for (const b of haproxy.bind) {
    if (typeof b !== 'string' || !b.trim() || /[\r\n#]/.test(b)) fail(`invalid bind line "${b}"`);
  }
  if (!CFG_TOKEN.test(haproxy.statsBind)) fail('haproxy.statsBind is invalid');
  if (!CFG_TOKEN.test(haproxy.statsUser) || haproxy.statsUser.includes(':')) {
    fail('haproxy.statsUser must not contain spaces, quotes, "#" or ":"');
  }

  if (haproxy.statusPath !== null && !URL_PATH.test(haproxy.statusPath)) {
    fail('haproxy.statusPath must be a plain path like "/lb-status"');
  }

  if (haproxy.maxConnPerNode !== null && !(Number.isInteger(haproxy.maxConnPerNode) && haproxy.maxConnPerNode > 0)) {
    fail('haproxy.maxConnPerNode must be a positive integer or null');
  }
  if (haproxy.clientIpHeader !== null && !HEADER.test(haproxy.clientIpHeader)) {
    fail('haproxy.clientIpHeader must be a header name like "CF-Connecting-IP"');
  }
  if (!Number.isInteger(haproxy.logBodyBytes) || haproxy.logBodyBytes < 0 || haproxy.logBodyBytes > 1024) {
    fail('haproxy.logBodyBytes must be an integer from 0 to 1024');
  }
  if (haproxy.maxHistoryLimit !== null && !(Number.isInteger(haproxy.maxHistoryLimit) && haproxy.maxHistoryLimit > 0)) {
    fail('haproxy.maxHistoryLimit must be a positive integer or null');
  }

  const seenNames = new Set();
  const seenPorts = new Set([agent.statusPort]);
  const nodes = raw.nodes.map((n, i) => {
    if (!n || !NAME.test(n.name || '')) {
      fail(`node #${i} needs a name of letters, digits, "_", "." or "-"`);
    }
    if (seenNames.has(n.name)) fail(`duplicate node name "${n.name}"`);
    seenNames.add(n.name);
    if (!HOST.test(n.host || '')) fail(`node "${n.name}" needs a valid host`);

    const node = {
      name: n.name,
      host: n.host,
      port: n.port ?? 8090,
      checkPort: n.checkPort ?? agent.basePort + i,
    };
    checkPort(node.port, `node "${n.name}" port`);
    checkPort(node.checkPort, `node "${n.name}" checkPort`);
    if (seenPorts.has(node.checkPort)) fail(`agent port ${node.checkPort} is used twice`);
    seenPorts.add(node.checkPort);
    return node;
  });

  return { agent, health, haproxy, nodes };
}

function loadConfig(path) {
  return normalize(JSON.parse(fs.readFileSync(path, 'utf8')));
}

module.exports = { loadConfig, normalize, DEFAULTS, CFG_TOKEN };
