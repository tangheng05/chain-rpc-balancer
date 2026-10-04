const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { render, historyLimitPattern } = require('../src/gen-haproxy');
const { loadConfig, normalize } = require('../src/config');

const example = loadConfig(path.join(__dirname, '..', 'nodes.example.json'));
const oneNode = (haproxy = {}) => normalize({ haproxy, nodes: [{ name: 'n', host: '10.0.0.1' }] });

test('every node appears in every backend with its agent check port', () => {
  const cfg = render(example, { env: {} });
  for (const n of example.nodes) {
    const line = `server ${n.name} ${n.host}:${n.port} check addr 127.0.0.1 port ${n.checkPort}`;
    assert.equal(cfg.split(line).length - 1, 3, `${n.name} should be in be_read, be_broadcast and be_ws`);
  }
  assert.doesNotMatch(cfg, /{{|}}/);
});

test('STATS_PASSWORD env overrides the config value', () => {
  const cfg = render(example, { env: { STATS_PASSWORD: 's3cret' } });
  assert.match(cfg, /stats auth admin:s3cret\n/);
});

test('"$" in the password is written literally', () => {
  const cfg = render(example, { env: { STATS_PASSWORD: 'a$&b$1c' } });
  assert.match(cfg, /stats auth admin:a\$&b\$1c\n/);
});

test('passwords that would break the config line are rejected', () => {
  for (const bad of ['has space', 'has#hash', 'q"uote']) {
    assert.throws(() => render(example, { env: { STATS_PASSWORD: bad } }), /stats password/);
  }
});

test('multiple bind lines are rendered', () => {
  const cfg = render(oneNode({ bind: [':80', ':443 ssl crt /etc/haproxy/certs/site.pem'] }), { env: {} });
  assert.match(cfg, /\n {4}bind :80\n/);
  assert.match(cfg, /\n {4}bind :443 ssl crt \/etc\/haproxy\/certs\/site.pem\n/);
});

test('CORS is on by default, without credentials, and can be turned off', () => {
  const cfg = render(oneNode(), { env: {} });
  assert.match(cfg, /Access-Control-Allow-Origin %\[var\(txn.origin\)\]/);
  assert.match(cfg, /add-header Vary Origin/);
  assert.doesNotMatch(cfg, /Allow-Credentials/);
  assert.match(render(oneNode({ corsCredentials: true }), { env: {} }), /Allow-Credentials true/);
  assert.doesNotMatch(render(oneNode({ cors: false }), { env: {} }), /Access-Control/);
});

test('HTTPS redirect is only added when enabled', () => {
  assert.doesNotMatch(render(oneNode(), { env: {} }), /redirect scheme/);
  assert.match(
    render(oneNode({ redirectHttps: true }), { env: {} }),
    /redirect scheme https code 308 unless \{ ssl_fc \}/,
  );
});

test('response timeouts are never retried', () => {
  assert.doesNotMatch(render(example, { env: {} }), /retry-on .*response-timeout/);
});

test('status path is off by default', () => {
  assert.doesNotMatch(render(oneNode(), { env: {} }), /be_status|is_status/);
});

test('status path routes to the agent and requires the token when one is set', () => {
  const cfg = render(oneNode({ statusPath: '/lb-status' }), { env: { STATUS_TOKEN: 't0k' } });
  assert.match(cfg, /acl is_status path \/lb-status\n/);
  assert.match(cfg, /deny deny_status 401 if is_status !\{ req.hdr\(x-status-token\) -m str t0k \}/);
  assert.match(cfg, /use_backend be_status if is_status\n[\s\S]*use_backend be_broadcast/);
  assert.match(cfg, /backend be_status\n {4}server agent 127.0.0.1:9100\n/);
  assert.throws(() => render(oneNode({ statusPath: '/s' }), { env: { STATUS_TOKEN: 'a b' } }), /status token/);
});

test('per-node connection limit is off by default and skips websockets', () => {
  assert.doesNotMatch(render(oneNode(), { env: {} }), /fail-check maxconn/);
  const cfg = render(oneNode({ maxConnPerNode: 4 }), { env: {} });
  assert.equal(cfg.split('on-error fail-check maxconn 4\n').length - 1, 2);
  assert.match(cfg, /backend be_ws\n[\s\S]*slowstart 30s\n {4}server n/);
  assert.match(cfg, /use_backend be_ws if is_websocket\n {4}use_backend be_broadcast/);
});

test('client IP header and request body are captured for the log when set', () => {
  assert.doesNotMatch(render(oneNode(), { env: {} }), /http-request capture/);
  const cfg = render(oneNode({ clientIpHeader: 'CF-Connecting-IP', logBodyBytes: 200 }), { env: {} });
  assert.match(cfg, /http-request capture req.hdr\(CF-Connecting-IP\) len 46\n {4}http-request capture req.body len 200\n/);
});

test('history limit rule is off by default and runs after the log captures', () => {
  assert.doesNotMatch(render(oneNode(), { env: {} }), /history_too_big/);
  const cfg = render(oneNode({ maxHistoryLimit: 1000, logBodyBytes: 200 }), { env: {} });
  assert.match(cfg, /capture req.body len 200\n {4}acl history_too_big req.body -m reg '[^'\n]+'\n {4}http-request return status 200 /);
  const body = cfg.match(/string '([^']+)' if history_too_big/)[1];
  assert.match(JSON.parse(body).error.message, /limit must be 1000 or less/);
});

test('history limit pattern only matches get_account_history over the limit', () => {
  // HAProxy regex syntax -> JS: POSIX space class, and "]" as a literal class.
  const re = new RegExp(historyLimitPattern(1000).replaceAll('[[:space:]]', '\\s').replaceAll('[]]', '\\]'));
  const call = (api, args) => JSON.stringify({ id: 0, jsonrpc: '2.0', method: 'call', params: [api, 'get_account_history', args] });
  const blocked = [
    call('condenser_api', ['evgeniy', -1, 10000]),
    call('database_api', ['a', 107947, 1001]),
    call('condenser_api', ['a', -1, 9999]),
    call('condenser_api', ['a', -1, 2000]),
    call('condenser_api', ['a', '-1', '5000']),
    '{"method":"call","params":["condenser_api","get_account_history",["a", -1, 10000]]}',
    '{"jsonrpc":"2.0","method":"condenser_api.get_account_history","params":["a",-1,10000],"id":1}',
  ];
  const allowed = [
    call('condenser_api', ['a', -1, 1000]),
    call('condenser_api', ['a', -1, 100]),
    call('condenser_api', ['a', 50000, 20]),
    call('database_api', ['cexius', -1, 1]),
    '{"method":"call","params":["condenser_api","get_discussions_by_blog",[{"tag":"a","limit":10000}]]}',
    '{"method":"call","params":["condenser_api","get_block",[47659057]]}',
  ];
  for (const b of blocked) assert.match(b, re);
  for (const b of allowed) assert.doesNotMatch(b, re);
});
