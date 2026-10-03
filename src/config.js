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
    statsBind: '127.0.0.1:8404',
    statsUser: 'admin',
    statsPassword: 'change-me',
  },
};

function normalize(raw) {
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error('config: "nodes" must be a non-empty array');
  }
  const agent = { ...DEFAULTS.agent, ...raw.agent };
  const health = { ...DEFAULTS.health, ...raw.health };
  const haproxy = { ...DEFAULTS.haproxy, ...raw.haproxy };
  if (typeof haproxy.bind === 'string') haproxy.bind = [haproxy.bind];

  const seen = new Set();
  const nodes = raw.nodes.map((n, i) => {
    if (!n.name || !/^[A-Za-z0-9_.-]+$/.test(n.name)) {
      throw new Error(`config: node #${i} needs a name of letters, digits, "_", "." or "-"`);
    }
    if (seen.has(n.name)) throw new Error(`config: duplicate node name "${n.name}"`);
    seen.add(n.name);
    if (!n.host) throw new Error(`config: node "${n.name}" needs a host`);
    return {
      name: n.name,
      host: n.host,
      port: n.port || 8090,
      checkPort: n.checkPort || agent.basePort + i,
    };
  });

  return { agent, health, haproxy, nodes };
}

function loadConfig(path) {
  return normalize(JSON.parse(fs.readFileSync(path, 'utf8')));
}

module.exports = { loadConfig, normalize, DEFAULTS };
