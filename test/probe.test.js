const test = require('node:test');
const assert = require('node:assert');
const { probe, parseChainTime } = require('../src/probe');
const { DEFAULTS } = require('../src/config');
const { mockNode, freePort, chainTime } = require('./helpers');

const health = { ...DEFAULTS.health, timeoutMs: 300 };

test('parseChainTime treats zone-less times as UTC', () => {
  assert.equal(parseChainTime('2026-01-01T00:00:00'), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(parseChainTime('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'));
});

test('reads head block and time from a healthy node', async () => {
  const node = await mockNode(() => ({ block: 42, time: chainTime() }));
  try {
    const r = await probe({ name: 'a', host: '127.0.0.1', port: node.port }, health);
    assert.equal(r.ok, true);
    assert.equal(r.headBlock, 42);
    assert.ok(Date.now() - r.headTime < 2000);
  } finally {
    node.close();
  }
});

test('JSON-RPC error inside an HTTP 200 counts as a failure', async () => {
  const node = await mockNode(() => ({ error: 'no method with name' }));
  try {
    const r = await probe({ name: 'a', host: '127.0.0.1', port: node.port }, health);
    assert.equal(r.ok, false);
    assert.match(r.error, /no method/);
  } finally {
    node.close();
  }
});

test('non-2xx status is a failure', async () => {
  const node = await mockNode(() => ({ status: 502 }));
  try {
    const r = await probe({ name: 'a', host: '127.0.0.1', port: node.port }, health);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HTTP 502');
  } finally {
    node.close();
  }
});

test('hanging node times out', async () => {
  const node = await mockNode(() => ({ hang: true }));
  try {
    const r = await probe({ name: 'a', host: '127.0.0.1', port: node.port }, health);
    assert.equal(r.ok, false);
    assert.match(r.error, /timeout after 300ms/);
  } finally {
    node.close();
  }
});

test('refused connection is a failure', async () => {
  const port = await freePort();
  const r = await probe({ name: 'a', host: '127.0.0.1', port }, health);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ECONNREFUSED');
});
