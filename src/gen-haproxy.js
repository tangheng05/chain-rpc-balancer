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

  const statusToken = env.STATUS_TOKEN || haproxy.statusToken;
  if (haproxy.statusPath && statusToken && !CFG_TOKEN.test(statusToken)) {
    throw new Error('status token must have no spaces, quotes, "#" or "\\"');
  }
  const statusFrontend = haproxy.statusPath
    ? [
        `    acl is_status path ${haproxy.statusPath}`,
        statusToken &&
          `    http-request deny deny_status 401 if is_status !{ req.hdr(x-status-token) -m str ${statusToken} }`,
      ].filter(Boolean)
    : [];
  const statusRoute = haproxy.statusPath ? ['    use_backend be_status if is_status'] : [];
  const statusBackend = haproxy.statusPath
    ? ['backend be_status', `    server agent ${agent.host}:${agent.statusPort}`, '']
    : [];

  const servers = nodes.map(
    (n) => `    server ${n.name} ${n.host}:${n.port} check addr ${agent.host} port ${n.checkPort}`,
  );
  const captures = [
    haproxy.clientIpHeader && `    http-request capture req.hdr(${haproxy.clientIpHeader}) len 46`,
    haproxy.logBodyBytes > 0 && `    http-request capture req.body len ${haproxy.logBodyBytes}`,
  ].filter(Boolean);
  const values = {
    BIND_LINES: haproxy.bind.map((b) => `    bind ${b}`),
    REDIRECT_LINES: haproxy.redirectHttps
      ? ['    http-request redirect scheme https code 308 unless { ssl_fc }']
      : [],
    CORS_LINES: haproxy.cors ? corsLines(haproxy) : [],
    SERVER_LINES: servers,
    CAPTURE_LINES: captures,
    NODE_LIMIT: haproxy.maxConnPerNode ? [` maxconn ${haproxy.maxConnPerNode}`] : [],
    STATUS_FRONTEND_LINES: statusFrontend,
    STATUS_ROUTE_LINES: statusRoute,
    STATUS_BACKEND_LINES: statusBackend,
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
    if (config.haproxy.statusPath && !process.env.STATUS_TOKEN && !config.haproxy.statusToken) {
      console.error(`warning: ${config.haproxy.statusPath} is public; set STATUS_TOKEN to protect it`);
    }
    process.stdout.write(render(config));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { render };
