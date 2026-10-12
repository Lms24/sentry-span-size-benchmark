# Sentry span size benchmark

The Sentry JavaScript SDK's span buffer needs a size per span to decide when to flush. Today it calls
[`estimateSerializedSpanSizeInBytes`](https://github.com/getsentry/sentry-javascript/blob/2af75e43f218ec63eba9cca337a27e7128b4e254/packages/core/src/tracing/spans/estimateSize.ts)
and does not serialize the span. This repo checks whether that estimate actually costs less than serializing the span
with `JSON.stringify` and measuring its real size.

**Result: the estimate costs less in every scenario.** It is 3–4× faster for typical spans and up to 20× faster for
very small or very large spans. Getting the exact UTF-8 byte size is the slowest option.

## Approaches compared

| Name                          | Code                                                    | Exact?                              |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `estimate`                    | `estimateSerializedSpanSizeInBytes(span)`               | No, heuristic                       |
| `stringify_length`            | `JSON.stringify(span).length`                           | No, UTF-16 code units, not bytes    |
| `stringify_textencoder`       | `encoder.encode(JSON.stringify(span)).length`           | Yes, works in every runtime         |
| `stringify_buffer_bytelength` | `Buffer.byteLength(JSON.stringify(span), 'utf8')`       | Yes, Node only                      |

`estimateSize.mjs` is the real SDK source (`packages/core/src/tracing/spans/estimateSize.ts` and its imports),
bundled with esbuild from sentry-javascript commit `2af75e43f2`. It is not a re-implementation.

## Methodology

- **Separate process per approach.** Each approach runs in a fresh `node` process, so inline caches and JIT
  feedback from one approach cannot affect another.
- **Realistic call site.** Before measuring, each process warms up for 1.5s on _all_ span shapes. The call site is
  then polymorphic, as it would be in a real app, and not tuned to a single shape.
- **No caching.** Each scenario uses a pool of 1024 different, randomly generated spans (random IDs, timestamps
  and string values). The loop cycles through the pool.
- **GC counted.** `gc()` runs once before each scenario. Garbage collection that happens _during_ measurement is
  included, so the cost of allocating the `JSON.stringify` strings counts.
- **Sampling.** The batch size is tuned to about 20ms per sample. Each scenario takes 40 samples, and the result is
  the median ns per call.
- **Repetition.** 7 rounds, with the order of approaches reversed every other round. The table shows the median
  of the 7 per-round medians, ± half the range across rounds.
- **Dead-code elimination** is prevented by adding every result to a sink that is printed at the end.

### Scenarios (`spans.mjs`)

| Scenario       | Shape                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| `minimal`      | No attributes                                                                        |
| `http_server`  | Segment span, 22 attributes (`sentry.*`, `http.*`, `url.*`, user agent, …)           |
| `db_query`     | 14 attributes, including a SQL statement of about 450 chars                          |
| `gen_ai_large` | 16 attributes, including a prompt of about 8 KB and a response of about 4 KB         |
| `many_attrs`   | 69 attributes, including one array attribute                                         |
| `with_links`   | 10 attributes and 5 span links, each with 2 attributes                               |
| `unicode`      | Non-ASCII span name and attribute values (umlauts, CJK, emoji)                       |
| `mixed`        | A shuffled mix of all scenarios above                                                |

## Results

Node 24.21.0, Apple M4 Max, macOS. Median ns per call, with the slowdown relative to `estimate` in parentheses.

| Scenario       | `estimate`  | `stringify_length` | `stringify_textencoder` | `stringify_buffer_bytelength` |
| -------------- | ----------- | ------------------ | ----------------------- | ----------------------------- |
| `minimal`      | **17 ± 1**  | 348 ± 11 (20×)     | 534 ± 119 (31×)         | 390 ± 6 (22×)                 |
| `http_server`  | **534 ± 22**| 2044 ± 83 (3.8×)   | 2510 ± 586 (4.7×)       | 2273 ± 37 (4.3×)              |
| `db_query`     | **361 ± 10**| 1443 ± 80 (4.0×)   | 1814 ± 279 (5.0×)       | 1626 ± 79 (4.5×)              |
| `gen_ai_large` | **408 ± 24**| 5461 ± 184 (13×)   | 7887 ± 1299 (19×)       | 6967 ± 323 (17×)              |
| `many_attrs`   | **5274 ± 298** | 6938 ± 516 (1.3×) | 7853 ± 766 (1.5×)      | 7288 ± 124 (1.4×)             |
| `with_links`   | **356 ± 8** | 2191 ± 135 (6.2×)  | 2745 ± 137 (7.7×)       | 2455 ± 91 (6.9×)              |
| `unicode`      | **265 ± 6** | 2395 ± 120 (9.0×)  | 5182 ± 376 (19.5×)      | 3057 ± 90 (11.5×)             |
| `mixed`        | **1078 ± 66** | 3145 ± 642 (2.9×) | 4316 ± 245 (4.0×)      | 3577 ± 119 (3.3×)             |

### Accuracy (`node sizes.mjs`)

One sample span per scenario, sizes in bytes:

| Scenario       | estimate | `JSON.stringify().length` | real UTF-8 bytes |
| -------------- | -------- | ------------------------- | ---------------- |
| `minimal`      | 182      | 255                       | 255              |
| `http_server`  | 1878     | 1626                      | 1626             |
| `db_query`     | 1932     | 1489                      | 1489             |
| `gen_ai_large` | 25308    | 13235                     | 13235            |
| `many_attrs`   | 4600     | 4236                      | 4236             |
| `with_links`   | 2232     | 2088                      | 2088             |
| `unicode`      | 1406     | 1262                      | 1561             |

The estimate undercounts small spans and overcounts large strings by about 1.9×, because it counts 2 bytes per
character. That is acceptable for deciding when to flush. Note that `JSON.stringify().length` is also wrong for
non-ASCII content.

## Observations

- **`TextEncoder` is the slowest and least stable option**, because it allocates a `Uint8Array` for every span. It is
  also the only exact option that works in every runtime.
- **The cost of the estimate is mostly `Object.entries`.** It only comes close to `JSON.stringify` for
  `many_attrs`. `entries.mjs` loops over only the attributes and compares two ways of doing it:

  | Attributes        | `Object.entries` | `for...in` |
  | ----------------- | ---------------- | ---------- |
  | `many_attrs` (69) | ~5200 ns         | ~1330 ns   |
  | `http_server` (22)| 112–500 ns       | ~53 ns     |

  Using `for...in` in `estimateTypedAttributesSizeInBytes` would make the estimate about 4× faster again.

## Running it

Needs Node 20 or newer. There are no dependencies.

```sh
npm run bench          # full benchmark (~1–2 min)
npm run sizes          # accuracy table
npm run bench:entries  # Object.entries vs for...in
```

Absolute numbers depend on your machine. The ratios between approaches should hold.
