const http = require('node:http');

// Mock JSON-RPC node; `behaviour` is mutable so tests can change it between checks.
async function mockNode(behaviour) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const b = behaviour();
      if (b.hang) return;
      res.writeHead(b.status || 200, { 'content-type': 'application/json' });
      if (b.error) return res.end(JSON.stringify({ id: 1, error: { message: b.error } }));
      res.end(JSON.stringify({ id: 1, result: { head_block_number: b.block, time: b.time } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => server.closeAllConnections() || server.close() };
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const chainTime = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().slice(0, 19);

module.exports = { mockNode, freePort, chainTime };
