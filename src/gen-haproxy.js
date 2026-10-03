const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'haproxy.cfg.tpl');

// Reflects the caller's Origin and answers preflights here instead of at the node.
const CORS = [
  'http-request set-var(txn.origin) req.hdr(origin)',
  'http-request return status 204 if METH_OPTIONS { var(txn.origin) -m found }',
  'http-after-response set-header Access-Control-Allow-Origin %[var(txn.origin)] if { var(txn.origin) -m found }',
  'http-after-response set-header Access-Control-Allow-Methods "GET, HEAD, OPTIONS, POST" if { var(txn.origin) -m found }',
  'http-after-response set-header Access-Control-Allow-Headers "Origin, Accept, X-Requested-With, Content-Type, Authorization" if { var(txn.origin) -m found }',
  'http-after-response set-header Access-Control-Allow-Credentials true if { var(txn.origin) -m found }',
  'http-after-response set-header Access-Control-Max-Age 86400 if { var(txn.origin) -m found }',
]
  .map((l) => `    ${l}`)
  .join('\n');

function render(config, { template = fs.readFileSync(TEMPLATE, 'utf8'), env = process.env } = {}) {
  const { agent, haproxy, nodes } = config;
  const password = env.STATS_PASSWORD || haproxy.statsPassword;
  if (/\s|:/.test(haproxy.statsUser) || /\s/.test(password)) {
    throw new Error('stats user/password must not contain spaces (or ":" in the user)');
  }

  const servers = nodes
    .map(
      (n) => `    server ${n.name} ${n.host}:${n.port} check addr ${agent.host} port ${n.checkPort}`,
    )
    .join('\n');

  const redirect = haproxy.redirectHttps
    ? '    http-request redirect scheme https code 308 unless { ssl_fc }'
    : '';

  return template
    .replace('{{BIND_LINES}}', haproxy.bind.map((b) => `    bind ${b}`).join('\n'))
    .replace('{{REDIRECT_LINES}}\n', redirect && `${redirect}\n`)
    .replace('{{CORS_LINES}}\n', haproxy.cors ? `${CORS}\n` : '')
    .replaceAll('{{SERVER_LINES}}', servers)
    .replace('{{STATS_BIND}}', haproxy.statsBind)
    .replace('{{STATS_AUTH}}', `${haproxy.statsUser}:${password}`);
}

if (require.main === module) {
  const config = loadConfig(process.argv[2] || 'nodes.json');
  if (!process.env.STATS_PASSWORD && config.haproxy.statsPassword === 'change-me') {
    console.error('warning: stats password is the default; set STATS_PASSWORD');
  }
  process.stdout.write(render(config));
}

module.exports = { render };
