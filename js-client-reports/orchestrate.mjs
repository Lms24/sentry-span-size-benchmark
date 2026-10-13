import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VARIANTS } from './variants.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const res = {};
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 ? [...VARIANTS].reverse() : VARIANTS;
  for (const v of order) {
    const { out } = JSON.parse(execFileSync(process.execPath, ['--expose-gc', runner, v], { encoding: 'utf8' }));
    for (const [s, m] of Object.entries(out)) ((res[s] ??= {})[v] ??= []).push(m.median);
  }
  process.stderr.write(`round ${r + 1}/${ROUNDS}\n`);
}

const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
const us = ns => (ns / 1000).toFixed(ns < 10_000 ? 2 : 1);
console.log(`Node ${process.version}. Median µs per op; variants show (+added µs, +%) vs baseline; ± = half range across rounds.\n`);
console.log('scenario'.padEnd(44) + VARIANTS.map(v => v.padStart(30)).join(''));
for (const [s, byV] of Object.entries(res)) {
  const base = med(byV.baseline);
  const cells = VARIANTS.map(v => {
    const m = med(byV[v]);
    const spread = (Math.max(...byV[v]) - Math.min(...byV[v])) / 2;
    const delta = v === 'baseline' ? '' : ` (+${us(m - base)}, ${(((m - base) / base) * 100).toFixed(0)}%)`;
    return `${us(m)} ±${us(spread)}${delta}`.padStart(30);
  });
  console.log(s.padEnd(44) + cells.join(''));
}
