const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../src/evaluate');

const health = { maxBlockAgeSec: 30, maxLagBlocks: 10 };
const now = Date.parse('2026-01-01T00:01:00Z');
const fresh = Date.parse('2026-01-01T00:00:57Z');
const stale = Date.parse('2026-01-01T00:00:00Z');

const byName = (list) => Object.fromEntries(list.map((r) => [r.name, r]));

test('healthy nodes are up', () => {
  const out = byName(
    evaluate(
      [
        { name: 'a', ok: true, headBlock: 100, headTime: fresh },
        { name: 'b', ok: true, headBlock: 99, headTime: fresh },
      ],
      now,
      health,
    ),
  );
  assert.equal(out.a.up, true);
  assert.equal(out.b.up, true);
});

test('failed probe is down with its error as reason', () => {
  const out = byName(
    evaluate(
      [
        { name: 'a', ok: true, headBlock: 100, headTime: fresh },
        { name: 'b', ok: false, error: 'timeout after 2000ms' },
      ],
      now,
      health,
    ),
  );
  assert.equal(out.b.up, false);
  assert.match(out.b.reason, /timeout/);
});

test('node lagging behind the best node is down', () => {
  const out = byName(
    evaluate(
      [
        { name: 'a', ok: true, headBlock: 100, headTime: fresh },
        { name: 'b', ok: true, headBlock: 85, headTime: fresh },
      ],
      now,
      health,
    ),
  );
  assert.equal(out.a.up, true);
  assert.equal(out.b.up, false);
  assert.match(out.b.reason, /15 blocks behind/);
});

test('stale node is down while another node is fresh', () => {
  const out = byName(
    evaluate(
      [
        { name: 'a', ok: true, headBlock: 100, headTime: fresh },
        { name: 'b', ok: true, headBlock: 100, headTime: stale },
      ],
      now,
      health,
    ),
  );
  assert.equal(out.b.up, false);
  assert.match(out.b.reason, /head block 60s old/);
});

test('when every node is stale the chain is halted, so the best nodes stay up', () => {
  const out = byName(
    evaluate(
      [
        { name: 'a', ok: true, headBlock: 100, headTime: stale },
        { name: 'b', ok: true, headBlock: 100, headTime: stale },
        { name: 'c', ok: true, headBlock: 50, headTime: stale },
      ],
      now,
      health,
    ),
  );
  assert.equal(out.a.up, true);
  assert.equal(out.b.up, true);
  assert.equal(out.c.up, false);
});

test('all probes failing marks everything down', () => {
  const out = evaluate(
    [
      { name: 'a', ok: false, error: 'ECONNREFUSED' },
      { name: 'b', ok: false, error: 'ECONNREFUSED' },
    ],
    now,
    health,
  );
  assert.ok(out.every((r) => r.up === false));
});
