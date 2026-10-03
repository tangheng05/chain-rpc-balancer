const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { render } = require('../src/gen-haproxy');
const { loadConfig, normalize } = require('../src/config');

const example = loadConfig(path.join(__dirname, '..', 'nodes.example.json'));

test('every node appears in both backends with its agent check port', () => {
  const cfg = render(example, { env: {} });
  for (const n of example.nodes) {
    const line = `server ${n.name} ${n.host}:${n.port} check addr 127.0.0.1 port ${n.checkPort}`;
    assert.equal(cfg.split(line).length - 1, 2, `${n.name} should be in be_read and be_broadcast`);
  }
  assert.doesNotMatch(cfg, /{{/);
});

test('STATS_PASSWORD env overrides the config value', () => {
  const cfg = render(example, { env: { STATS_PASSWORD: 's3cret' } });
  assert.match(cfg, /stats auth admin:s3cret/);
});

test('multiple bind lines are rendered', () => {
  const config = normalize({
    haproxy: { bind: [':80', ':443 ssl crt /etc/haproxy/certs/site.pem'] },
    nodes: [{ name: 'n', host: '10.0.0.1' }],
  });
  const cfg = render(config, { env: {} });
  assert.match(cfg, /bind :80\n/);
  assert.match(cfg, /bind :443 ssl crt/);
});

test('CORS is on by default and can be turned off', () => {
  assert.match(render(example, { env: {} }), /Access-Control-Allow-Origin %\[var\(txn.origin\)\]/);
  const off = normalize({ haproxy: { cors: false }, nodes: [{ name: 'n', host: '10.0.0.1' }] });
  assert.doesNotMatch(render(off, { env: {} }), /Access-Control/);
});

test('HTTPS redirect is only added when enabled', () => {
  assert.doesNotMatch(render(example, { env: {} }), /redirect scheme/);
  const on = normalize({ haproxy: { redirectHttps: true }, nodes: [{ name: 'n', host: '10.0.0.1' }] });
  assert.match(render(on, { env: {} }), /redirect scheme https code 308 unless \{ ssl_fc \}/);
});

test('config rejects duplicate and unsafe node names', () => {
  assert.throws(() => normalize({ nodes: [{ name: 'a', host: 'x' }, { name: 'a', host: 'y' }] }), /duplicate/);
  assert.throws(() => normalize({ nodes: [{ name: 'a b', host: 'x' }] }), /name/);
  assert.throws(() => normalize({ nodes: [] }), /non-empty/);
});
