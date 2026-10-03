const http = require('node:http');
const { loadConfig } = require('./config');
const { probe } = require('./probe');
const { evaluate } = require('./evaluate');

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function createAgent(config, { log = console.log } = {}) {
  const { agent, health, nodes } = config;
  const state = new Map(nodes.map((n) => [n.name, { up: false, reason: 'starting' }]));
  let lastRunAt = null;
  let timer = null;
  let stopped = false;
  const servers = [];

  async function tick() {
    const results = await Promise.all(nodes.map((n) => probe(n, health)));
    const now = Date.now();
    const verdicts = evaluate(results, now, health);
    verdicts.forEach((v, i) => {
      const prev = state.get(v.name);
      if (prev.up !== v.up) log(`${v.name} ${v.up ? 'UP' : 'DOWN'}: ${v.reason}`);
      state.set(v.name, { ...v, latencyMs: results[i].latencyMs });
    });
    lastRunAt = now;
  }

  async function loop() {
    try {
      await tick();
    } catch (err) {
      log(`check loop error: ${err.message}`);
    }
    if (!stopped) timer = setTimeout(loop, agent.intervalMs);
  }

  async function start() {
    for (const node of nodes) {
      const server = http.createServer((req, res) => {
        const s = state.get(node.name);
        res.writeHead(s.up ? 200 : 503, { 'content-type': 'text/plain' });
        res.end(`${s.reason}\n`);
      });
      servers.push(await listen(server, node.checkPort, agent.host));
    }
    const status = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lastRunAt, nodes: [...state.values()] }, null, 2));
    });
    servers.push(await listen(status, agent.statusPort, agent.host));
    await loop();
  }

  async function stop() {
    stopped = true;
    clearTimeout(timer);
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }

  return { start, stop, tick, state };
}

if (require.main === module) {
  const path = process.argv[2] || 'nodes.json';
  const agent = createAgent(loadConfig(path));
  agent.start().then(
    () => console.log(`health agent running for ${path}`),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
  const shutdown = () => agent.stop().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createAgent };
