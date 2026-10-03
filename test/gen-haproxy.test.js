const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { render } = require('../src/gen-haproxy');
const { loadConfig, normalize } = require('../src/config');

const example = loadConfig(path.join(__dirname, '..', 'nodes.example.json'));
const oneNode = (haproxy = {}) => normalize({ haproxy, nodes: [{ name: 'n', host: '10.0.0.1' }] });

test('every node appears in both backends with its agent check port', () => {
  const cfg = render(example, { env: {} });
  for (const n of example.nodes) {
    const line = `server ${n.name} ${n.host}:${n.port} check addr 127.0.0.1 port ${n.checkPort}`;
    assert.equal(cfg.split(line).length - 1, 2, `${n.name} should be in be_read and be_broadcast`);
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
