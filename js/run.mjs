// Usage: node --expose-gc run.mjs <candidate>
// One candidate per process so JIT feedback / inline caches of one approach
// cannot affect another. All scenarios are warmed together so the call site
// sees every span shape, like it would in a real app.
import { estimateSerializedSpanSizeInBytes } from './estimateSize.mjs';
import { makePool, scenarios } from './spans.mjs';

const encoder = new TextEncoder();
const candidates = {
  estimate: span => estimateSerializedSpanSizeInBytes(span),
  stringify_length: span => JSON.stringify(span).length,
  stringify_textencoder: span => encoder.encode(JSON.stringify(span)).length,
  stringify_buffer_bytelength: span => Buffer.byteLength(JSON.stringify(span), 'utf8'),
};

const name = process.argv[2];
const fn = candidates[name];
if (!fn) throw new Error('unknown candidate ' + name);

const POOL = 1024;
const names = Object.keys(scenarios);
const pools = Object.fromEntries(names.map(n => [n, makePool(n, POOL)]));
pools.mixed = names.flatMap(n => pools[n].slice(0, POOL / names.length | 0)).sort(() => Math.random() - 0.5);

let sink = 0;
function runBatch(pool, iters) {
  const len = pool.length;
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < iters; k++) sink += fn(pool[k % len]);
  return Number(process.hrtime.bigint() - t0);
}

// Warmup: all shapes, ~1.5s total.
const warmEnd = Date.now() + 1500;
while (Date.now() < warmEnd) for (const n of Object.keys(pools)) runBatch(pools[n], 2000);

const SAMPLES = 40;
const TARGET_NS = 20e6; // ~20ms per sample
const out = {};
for (const n of Object.keys(pools)) {
  const pool = pools[n];
  // calibrate batch size
  let iters = 1000;
  while (runBatch(pool, iters) < TARGET_NS / 4) iters *= 2;
  iters = Math.max(1000, Math.round((iters * TARGET_NS) / runBatch(pool, iters)));
  global.gc?.();
  const samples = [];
  for (let k = 0; k < SAMPLES; k++) samples.push(runBatch(pool, iters) / iters);
  samples.sort((a, b) => a - b);
  out[n] = { median: samples[SAMPLES >> 1], p10: samples[(SAMPLES * 0.1) | 0], p90: samples[(SAMPLES * 0.9) | 0] };
}
process.stdout.write(JSON.stringify({ name, out, sink: sink % 7 }) + '\n');
