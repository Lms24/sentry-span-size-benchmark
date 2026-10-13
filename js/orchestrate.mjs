import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const cands = ['estimate', 'stringify_length', 'stringify_textencoder', 'stringify_buffer_bytelength'];
const ROUNDS = 7;
const res = {};
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 ? [...cands].reverse() : cands;
  for (const c of order) {
    const { out } = JSON.parse(execFileSync(process.execPath, ['--expose-gc', runner, c], { encoding: 'utf8' }));
    for (const [s, v] of Object.entries(out)) ((res[s] ??= {})[c] ??= []).push(v.median);
  }
  process.stderr.write(`round ${r + 1}/${ROUNDS}\n`);
}
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
const fmt = n => n.toFixed(1).padStart(9);
console.log('scenario'.padEnd(14) + cands.map(c => c.slice(0, 26).padStart(28)).join(''));
for (const [s, byC] of Object.entries(res)) {
  const base = med(byC.estimate);
  console.log(
    s.padEnd(14) +
      cands
        .map(c => {
          const m = med(byC[c]);
          const spread = Math.max(...byC[c]) - Math.min(...byC[c]);
          return `${fmt(m)}ns ±${(spread / 2).toFixed(1).padStart(6)} ${(m / base).toFixed(1).padStart(5)}x`.padStart(28);
        })
        .join(''),
  );
}
