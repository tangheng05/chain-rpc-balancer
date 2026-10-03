const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, CFG_TOKEN } = require('./config');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'haproxy.cfg.tpl');

const HAS_ORIGIN = 'if { var(txn.origin) -m found }';

// Reflects the caller's Origin and answers preflights here instead of at the node.
function corsLines({ corsCredentials }) {
  return [
    'http-request set-var(txn.origin) req.hdr(origin)',
    'http-request return status 204 if METH_OPTIONS { var(txn.origin) -m found }',
    `http-after-response set-header Access-Control-Allow-Origin %[var(txn.origin)] ${HAS_ORIGIN}`,
    `http-after-response add-header Vary Origin ${HAS_ORIGIN}`,
    `http-after-response set-header Access-Control-Allow-Methods "GET, HEAD, OPTIONS, POST" ${HAS_ORIGIN}`,
    `http-after-response set-header Access-Control-Allow-Headers "Origin, Accept, X-Requested-With, Content-Type, Authorization" ${HAS_ORIGIN}`,
    corsCredentials && `http-after-response set-header Access-Control-Allow-Credentials true ${HAS_ORIGIN}`,
    `http-after-response set-header Access-Control-Max-Age 86400 ${HAS_ORIGIN}`,
  ]
    .filter(Boolean)
    .map((l) => `    ${l}`);
}

function render(config, { template = fs.readFileSync(TEMPLATE, 'utf8'), env = process.env } = {}) {
  const { agent, haproxy, nodes } = config;
  const password = env.STATS_PASSWORD || haproxy.statsPassword;
  if (!CFG_TOKEN.test(password || '')) {
    throw new Error('stats password must be non-empty with no spaces, quotes, "#" or "\\"');
  }

  const servers = nodes.map(
    (n) => `    server ${n.name} ${n.host}:${n.port} check addr ${agent.host} port ${n.checkPort}`,
  );
  const values = {
    BIND_LINES: haproxy.bind.map((b) => `    bind ${b}`),
    REDIRECT_LINES: haproxy.redirectHttps
      ? ['    http-request redirect scheme https code 308 unless { ssl_fc }']
      : [],
    CORS_LINES: haproxy.cors ? corsLines(haproxy) : [],
    SERVER_LINES: servers,
    STATS_BIND: [haproxy.statsBind],
    STATS_AUTH: [`${haproxy.statsUser}:${password}`],
  };

  // Function replacers so "$" in values is never treated as a replacement pattern.
  return template
    .replace(/^\{\{(\w+)\}\}\n/gm, (m, key) => {
      if (!(key in values)) throw new Error(`unknown template key ${key}`);
      return values[key].map((l) => `${l}\n`).join('');
    })
    .replace(/\{\{(\w+)\}\}/g, (m, key) => {
      if (!(key in values)) throw new Error(`unknown template key ${key}`);
      return values[key].join('');
    });
}

if (require.main === module) {
  try {
    const config = loadConfig(process.argv[2] || 'nodes.json');
    if (!process.env.STATS_PASSWORD && config.haproxy.statsPassword === 'change-me') {
      console.error('warning: stats password is the default; set STATS_PASSWORD');
    }
    process.stdout.write(render(config));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { render };
