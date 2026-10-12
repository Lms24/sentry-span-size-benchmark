import { estimateSerializedSpanSizeInBytes } from './estimateSize.mjs';
import { makePool, scenarios } from './spans.mjs';

for (const n of Object.keys(scenarios)) {
  const [span] = makePool(n, 1);
  const j = JSON.stringify(span);
  console.log(
    n.padEnd(14),
    'estimate',
    String(estimateSerializedSpanSizeInBytes(span)).padStart(6),
    ' str.length',
    String(j.length).padStart(6),
    ' utf8 bytes',
    String(Buffer.byteLength(j)).padStart(6),
  );
}
