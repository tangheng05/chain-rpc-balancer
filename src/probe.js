// Graphene nodes return times like "2026-01-01T00:00:00" with no zone; they are UTC.
function parseChainTime(t) {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}

async function probe(node, { timeoutMs, payload }) {
  const started = Date.now();
  const fail = (error) => ({ name: node.name, ok: false, error, latencyMs: Date.now() - started });
  try {
    const res = await fetch(`http://${node.host}:${node.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);

    const body = await res.json();
    if (body.error) return fail(`rpc error: ${body.error.message || 'unknown'}`.slice(0, 200));

    const { head_block_number: headBlock, time } = body.result || {};
    const headTime = parseChainTime(time);
    if (!Number.isInteger(headBlock) || Number.isNaN(headTime)) {
      return fail('unexpected response shape');
    }
    return { name: node.name, ok: true, headBlock, headTime, latencyMs: Date.now() - started };
  } catch (err) {
    if (err.name === 'TimeoutError') return fail(`timeout after ${timeoutMs}ms`);
    return fail(err.cause?.code || err.message);
  }
}

module.exports = { probe, parseChainTime };
