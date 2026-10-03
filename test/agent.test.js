const test = require('node:test');
const assert = require('node:assert');
const { createAgent } = require('../src/agent');
const { normalize } = require('../src/config');
const { mockNode, freePort, chainTime } = require('./helpers');

test('check ports flip to 503 when a node falls behind and back to 200 when it recovers', async () => {
  let bBehaviour = { block: 100 };
  const a = await mockNode(() => ({ block: 100, time: chainTime() }));
  const b = await mockNode(() => ({ ...bBehaviour, time: chainTime() }));
  const [statusPort, checkA, checkB] = [await freePort(), await freePort(), await freePort()];

  const config = normalize({
    agent: { statusPort, intervalMs: 60000 },
    health: { timeoutMs: 300 },
    nodes: [
      { name: 'a', host: '127.0.0.1', port: a.port, checkPort: checkA },
      { name: 'b', host: '127.0.0.1', port: b.port, checkPort: checkB },
    ],
  });
  const agent = createAgent(config, { log: () => {} });
  const check = (port) => fetch(`http://127.0.0.1:${port}/`).then((r) => r.status);

  try {
    await agent.start();
    assert.equal(await check(checkA), 200);
    assert.equal(await check(checkB), 200);

    bBehaviour = { block: 50 };
    await agent.tick();
    assert.equal(await check(checkB), 503);
    const res = await fetch(`http://127.0.0.1:${checkB}/`);
    assert.match(await res.text(), /50 blocks behind/);

    bBehaviour = { block: 100 };
    await agent.tick();
    assert.equal(await check(checkB), 200);

    const status = await fetch(`http://127.0.0.1:${statusPort}/`).then((r) => r.json());
    assert.equal(status.nodes.length, 2);
    assert.ok(status.lastRunAt);
  } finally {
    await agent.stop();
    a.close();
    b.close();
  }
});
