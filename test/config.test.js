const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('../src/config');

const node = (extra = {}) => ({ name: 'n', host: '10.0.0.1', ...extra });

test('defaults fill in ports and thresholds', () => {
  const c = normalize({ nodes: [node(), node({ name: 'm' })] });
  assert.deepEqual(
    c.nodes.map((n) => [n.port, n.checkPort]),
    [
      [8090, 9101],
      [8090, 9102],
    ],
  );
  assert.equal(c.health.maxLagBlocks, 10);
});

test('rejects a missing or empty node list', () => {
  assert.throws(() => normalize({}), /non-empty/);
  assert.throws(() => normalize({ nodes: [] }), /non-empty/);
});

test('rejects duplicate and unsafe node names', () => {
  assert.throws(() => normalize({ nodes: [node(), node()] }), /duplicate/);
  assert.throws(() => normalize({ nodes: [node({ name: 'a b' })] }), /name/);
});

test('rejects hosts that could inject haproxy config', () => {
  assert.throws(
    () => normalize({ nodes: [node({ host: '10.0.0.1 check\n    server evil 6.6.6.6' })] }),
    /valid host/,
  );
});

test('rejects bad ports and port collisions', () => {
  assert.throws(() => normalize({ nodes: [node({ port: 70000 })] }), /port/);
  assert.throws(() => normalize({ nodes: [node({ port: '8090' })] }), /port/);
  assert.throws(() => normalize({ nodes: [node({ checkPort: 9100 })] }), /used twice/);
  assert.throws(
    () => normalize({ nodes: [node({ checkPort: 9200 }), node({ name: 'm', checkPort: 9200 })] }),
    /used twice/,
  );
});

test('rejects nonsense thresholds', () => {
  assert.throws(() => normalize({ health: { timeoutMs: 0 }, nodes: [node()] }), /timeoutMs/);
  assert.throws(() => normalize({ health: { maxLagBlocks: -1 }, nodes: [node()] }), /maxLagBlocks/);
  assert.throws(() => normalize({ agent: { intervalMs: 'x' }, nodes: [node()] }), /intervalMs/);
});

test('rejects bind lines with newlines or comments', () => {
  assert.throws(() => normalize({ haproxy: { bind: [':80\n    bind :81'] }, nodes: [node()] }), /bind/);
  assert.throws(() => normalize({ haproxy: { bind: [] }, nodes: [node()] }), /bind/);
});

test('rejects status paths that could inject config', () => {
  assert.throws(() => normalize({ haproxy: { statusPath: 'lb-status' }, nodes: [node()] }), /statusPath/);
  assert.throws(() => normalize({ haproxy: { statusPath: '/a b' }, nodes: [node()] }), /statusPath/);
  assert.equal(normalize({ haproxy: { statusPath: '/lb-status' }, nodes: [node()] }).haproxy.statusPath, '/lb-status');
});

test('load limit and log capture settings are validated', () => {
  const withHaproxy = (haproxy) => () => normalize({ haproxy, nodes: [{ name: 'n', host: '10.0.0.1' }] });
  assert.throws(withHaproxy({ maxConnPerNode: 0 }), /maxConnPerNode/);
  assert.throws(withHaproxy({ maxConnPerNode: 2.5 }), /maxConnPerNode/);
  assert.throws(withHaproxy({ clientIpHeader: 'X Real IP' }), /clientIpHeader/);
  assert.throws(withHaproxy({ logBodyBytes: 4096 }), /logBodyBytes/);
  assert.doesNotThrow(withHaproxy({ maxConnPerNode: 4, clientIpHeader: 'CF-Connecting-IP', logBodyBytes: 200 }));
});
