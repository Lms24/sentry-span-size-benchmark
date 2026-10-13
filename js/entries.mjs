import { makePool } from './spans.mjs';

const pool = makePool(process.argv[2] ?? 'many_attrs', 1024);
const viaEntries = attrs => {
  let w = 0;
  for (const [k, a] of Object.entries(attrs)) w += k.length + a.type.length;
  return w;
};
const viaForIn = attrs => {
  let w = 0;
  for (const k in attrs) w += k.length + attrs[k].type.length;
  return w;
};
let sink = 0;
for (const [name, fn] of [['entries', viaEntries], ['for-in', viaForIn], ['entries', viaEntries], ['for-in', viaForIn]]) {
  for (let k = 0; k < 200000; k++) sink += fn(pool[k & 1023].attributes);
  const t0 = process.hrtime.bigint();
  const N = 500000;
  for (let k = 0; k < N; k++) sink += fn(pool[k & 1023].attributes);
  console.log(name.padEnd(8), (Number(process.hrtime.bigint() - t0) / N).toFixed(1), 'ns/op');
}
console.log(sink % 7);
