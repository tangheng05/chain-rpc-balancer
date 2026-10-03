function evaluate(results, now, { maxBlockAgeSec, maxLagBlocks }) {
  const ok = results.filter((r) => r.ok);
  const best = Math.max(...ok.map((r) => r.headBlock));
  const isFresh = (r) => now - r.headTime <= maxBlockAgeSec * 1000;
  // A chain-wide halt makes every node stale; don't take them all down for it.
  const chainHalted = ok.length > 0 && !ok.some(isFresh);

  return results.map((r) => {
    const base = { name: r.name, headBlock: r.headBlock ?? null };
    if (!r.ok) return { ...base, up: false, reason: r.error || 'probe failed' };

    const lag = best - r.headBlock;
    if (lag > maxLagBlocks) {
      return { ...base, up: false, reason: `${lag} blocks behind best node` };
    }
    if (!chainHalted && !isFresh(r)) {
      const age = Math.round((now - r.headTime) / 1000);
      return { ...base, up: false, reason: `head block ${age}s old` };
    }
    return { ...base, up: true, reason: chainHalted ? 'up (chain halted)' : 'up' };
  });
}

module.exports = { evaluate };
