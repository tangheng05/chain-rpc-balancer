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

// Regex alternation matching any whole non-negative integer greater than n.
function greaterThan(n) {
  const s = String(n);
  const alts = [`[1-9][0-9]{${s.length},}`];
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const rest = s.length - i - 1;
    if (d < 9) alts.push(`${s.slice(0, i)}[${d + 1}-9]${rest ? `[0-9]{${rest}}` : ''}`);
  }
  return `(${alts.join('|')})`;
}

// Matches get_account_history(account, from, limit) with limit > max, in both
// "call" and "condenser_api.get_account_history" forms. No backslashes, so it
// reads the same in PCRE and POSIX regex builds.
function historyLimitPattern(max) {
  const sp = '[[:space:]]*';
  return `get_account_history"[^[]*[[]${sp}"[^"]*"${sp},${sp}"?-?[0-9]+"?${sp},${sp}"?${greaterThan(max)}"?${sp}[]]`;
}

function historyLimitLines(max) {
  const error = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32602, message: `get_account_history limit must be ${max} or less; page with the from argument` },
    id: null,
  });
  return [
    `    acl history_too_big req.body -m reg '${historyLimitPattern(max)}'`,
    `    http-request return status 200 content-type application/json string '${error}' if history_too_big`,
  ];
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
    HISTORY_LIMIT_LINES: haproxy.maxHistoryLimit ? historyLimitLines(haproxy.maxHistoryLimit) : [],
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

module.exports = { render, historyLimitPattern };
