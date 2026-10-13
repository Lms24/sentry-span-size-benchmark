# Sentry span size benchmark

With span streaming, the Sentry SDKs buffer spans per trace and flush a buffer once it gets too big. To do that,
they need a size for each span as it is added. The JavaScript and Python SDKs both **estimate** that size instead of
serializing the span. This repo checks whether the estimate actually costs less than serializing the span and
measuring its exact size, and how accurate it is.

**Result: in both SDKs, the estimate costs less in every scenario.**

| SDK        | Estimate                                        | Speed-up over exact size, typical spans | Range     |
| ---------- | ----------------------------------------------- | --------------------------------------- | --------- |
| JavaScript | `estimateSerializedSpanSizeInBytes`             | 3–4×                                    | 1.3–31×   |
| Python     | `SpanBatcher._estimate_size`                    | 11–16×                                  | 10–32×    |

- [JavaScript](#javascript) (`js/`)
- [Python](#python) (`python/`)
- [The two estimates compared](#the-two-estimates-compared)

## Methodology

Both benchmarks use the same setup:

- **Real SDK code.** `js/estimateSize.mjs` is the SDK source bundled with esbuild. `python/vendored.py` contains
  the SDK functions copied unchanged (only type annotations removed). Both files name the source commit.
- **Separate process per approach.** Each approach runs in a fresh process. In JS this keeps JIT feedback and inline
  caches from one approach away from the others. Python does the same, so the two setups match.
- **Realistic call site.** Before measuring, each process warms up on _all_ span shapes (1.5s in JS, 1s in Python).
- **No caching.** Each scenario uses a pool of 1024 different, randomly generated spans (random IDs, timestamps
  and string values). The loop cycles through the pool.
- **GC counted.** A full GC runs once before each scenario. Garbage collection that happens _during_ measurement is
  included, so the cost of allocating the serialized strings counts. (Python's `timeit` turns GC off; this harness
  does not.)
- **Sampling.** The batch size is tuned to about 20ms per sample. Each scenario takes 40 samples, and the result is
  the median ns per call.
- **Repetition.** 7 rounds, with the order of approaches reversed every other round. Tables show the median of the
  7 per-round medians, ± half the range across rounds.
- **Dead-code elimination** is prevented by adding every result to a sink that is printed at the end.

### Scenarios

The same span shapes are used in both languages (`js/spans.mjs`, `python/spans.py`):

| Scenario       | Shape                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| `minimal`      | No attributes                                                                        |
| `http_server`  | Segment span, 22 attributes (`sentry.*`, `http.*`, `url.*`, user agent, …)           |
| `db_query`     | 14 attributes, including a SQL statement of about 450 chars                          |
| `gen_ai_large` | 16 attributes, including a prompt of about 8 KB and a response of about 4 KB         |
| `many_attrs`   | 69 attributes, including one array attribute                                         |
| `with_links`   | JS only: 10 attributes and 5 span links, each with 2 attributes                      |
| `unicode`      | Non-ASCII span name and attribute values (umlauts, CJK, emoji)                       |
| `mixed`        | A shuffled mix of all scenarios above                                                |

All results: Apple M4 Max, macOS.

## JavaScript

Source: [`estimateSerializedSpanSizeInBytes`](https://github.com/getsentry/sentry-javascript/blob/2af75e43f218ec63eba9cca337a27e7128b4e254/packages/core/src/tracing/spans/estimateSize.ts)
at sentry-javascript `2af75e43f2`. Spans are already in the typed attribute format (`{ type, value }`) when they
reach the buffer.

| Name                          | Code                                                    | Exact?                              |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `estimate`                    | `estimateSerializedSpanSizeInBytes(span)`               | No, heuristic                       |
| `stringify_length`            | `JSON.stringify(span).length`                           | No, UTF-16 code units, not bytes    |
| `stringify_textencoder`       | `encoder.encode(JSON.stringify(span)).length`           | Yes, works in every runtime         |
| `stringify_buffer_bytelength` | `Buffer.byteLength(JSON.stringify(span), 'utf8')`       | Yes, Node only                      |

### Speed

Node 24.21.0. Median ns per call, with the slowdown relative to `estimate` in parentheses.

| Scenario       | `estimate`     | `stringify_length` | `stringify_textencoder` | `stringify_buffer_bytelength` |
| -------------- | -------------- | ------------------ | ----------------------- | ----------------------------- |
| `minimal`      | **17 ± 1**     | 348 ± 11 (20×)     | 534 ± 119 (31×)         | 390 ± 6 (22×)                 |
| `http_server`  | **534 ± 22**   | 2044 ± 83 (3.8×)   | 2510 ± 586 (4.7×)       | 2273 ± 37 (4.3×)              |
| `db_query`     | **361 ± 10**   | 1443 ± 80 (4.0×)   | 1814 ± 279 (5.0×)       | 1626 ± 79 (4.5×)              |
| `gen_ai_large` | **408 ± 24**   | 5461 ± 184 (13×)   | 7887 ± 1299 (19×)       | 6967 ± 323 (17×)              |
| `many_attrs`   | **5274 ± 298** | 6938 ± 516 (1.3×)  | 7853 ± 766 (1.5×)       | 7288 ± 124 (1.4×)             |
| `with_links`   | **356 ± 8**    | 2191 ± 135 (6.2×)  | 2745 ± 137 (7.7×)       | 2455 ± 91 (6.9×)              |
| `unicode`      | **265 ± 6**    | 2395 ± 120 (9.0×)  | 5182 ± 376 (19.5×)      | 3057 ± 90 (11.5×)             |
| `mixed`        | **1078 ± 66**  | 3145 ± 642 (2.9×)  | 4316 ± 245 (4.0×)       | 3577 ± 119 (3.3×)             |

### Accuracy

One sample span per scenario (`node js/sizes.mjs`), sizes in bytes:

| Scenario       | estimate | `JSON.stringify().length` | exact UTF-8 bytes | estimate / exact |
| -------------- | -------- | ------------------------- | ----------------- | ---------------- |
| `minimal`      | 182      | 255                       | 255               | 0.71             |
| `http_server`  | 1878     | 1626                      | 1626              | 1.15             |
| `db_query`     | 1932     | 1489                      | 1489              | 1.30             |
| `gen_ai_large` | 25308    | 13235                     | 13235             | 1.91             |
| `many_attrs`   | 4600     | 4236                      | 4236              | 1.09             |
| `with_links`   | 2232     | 2088                      | 2088              | 1.07             |
| `unicode`      | 1406     | 1262                      | 1561              | 0.90             |

The estimate undercounts small spans and overcounts large strings by about 1.9×, because it counts 2 bytes per
character. That is acceptable for deciding when to flush. Note that `JSON.stringify().length` is also wrong for
non-ASCII content.

### Observations

- **`TextEncoder` is the slowest and least stable option**, because it allocates a `Uint8Array` for every span. It is
  also the only exact option that works in every runtime.
- **The cost of the estimate is mostly `Object.entries`.** It only comes close to `JSON.stringify` for
  `many_attrs`. `js/entries.mjs` loops over only the attributes and compares two ways of doing it:

  | Attributes         | `Object.entries` | `for...in` |
  | ------------------ | ---------------- | ---------- |
  | `many_attrs` (69)  | ~5200 ns         | ~1330 ns   |
  | `http_server` (22) | 112–500 ns       | ~53 ns     |

  Using `for...in` in `estimateTypedAttributesSizeInBytes` would make the estimate about 4× faster again.

## Python

Source: [`SpanBatcher._estimate_size`](https://github.com/getsentry/sentry-python/blob/7cb80948cbdefb10831740c23b49e56e348532a5/sentry_sdk/_span_batcher.py#L156-L170)
at sentry-python `7cb80948cb`:

```python
estimate = 210
for value in (item.get("attributes") or {}).values():
    estimate += 50
    if isinstance(value, str):
        estimate += len(value)
    else:
        estimate += len(str(value))
return estimate
```

Unlike JS, the Python buffer holds spans with **raw** attribute values (`"GET"`, `200`). They are converted to the
typed transport format (`{"value": ..., "type": ...}`) only when the buffer is flushed. So an exact size at `add()`
time means doing that conversion _and_ serializing:

| Name            | Code                                                                    | Exact? |
| --------------- | ----------------------------------------------------------------------- | ------ |
| `estimate`      | `SpanBatcher._estimate_size(span)`                                      | No     |
| `exact_bytes`   | `len(json_dumps(to_transport_format(span)))`, the SDK's own functions   | Yes    |
| `exact_str_len` | Same, but `len(json.dumps(...))` without `.encode("utf-8")`             | Yes    |

`exact_str_len` gives the same number as `exact_bytes`: `json.dumps` escapes non-ASCII characters by default, so the
output is pure ASCII.

### Speed

CPython 3.14.8. Median ns per call, with the slowdown relative to `estimate` in parentheses.

| Scenario       | `estimate`      | `exact_bytes`        | `exact_str_len`      |
| -------------- | --------------- | -------------------- | -------------------- |
| `minimal`      | **106 ± 2**     | 2675 ± 85 (25×)      | 2583 ± 94 (24×)      |
| `http_server`  | **1100 ± 62**   | 12333 ± 278 (11×)    | 12200 ± 283 (11×)    |
| `db_query`     | **579 ± 12**    | 9225 ± 213 (16×)     | 9207 ± 462 (16×)     |
| `gen_ai_large` | **790 ± 24**    | 25312 ± 1074 (32×)   | 25353 ± 652 (32×)    |
| `many_attrs`   | **3039 ± 137**  | 30974 ± 1937 (10×)   | 30267 ± 1184 (10×)   |
| `unicode`      | **398 ± 20**    | 8369 ± 301 (21×)     | 8131 ± 391 (20×)     |
| `mixed`        | **1089 ± 25**   | 15623 ± 471 (14×)    | 15132 ± 618 (14×)    |

### Accuracy

Average over 100 spans per scenario (`python3 python/sizes.py`), sizes in bytes:

| Scenario       | estimate | exact bytes | estimate / exact |
| -------------- | -------- | ----------- | ---------------- |
| `minimal`      | 210      | 239         | 0.88             |
| `http_server`  | 1660     | 1620        | 1.02             |
| `db_query`     | 1486     | 1481        | 1.00             |
| `gen_ai_large` | 13165    | 13232       | 0.99             |
| `many_attrs`   | 4492     | 4233        | 1.06             |
| `unicode`      | 1082     | 2363        | 0.46             |

### Observations

- **The gap is much bigger than in JS** (10–32× instead of 1.3–31×). An exact size in Python needs the
  pure-Python `to_transport_format` step to build a new dict for every attribute, and then `json.dumps`.
- **Skipping `.encode()` saves almost nothing** (≤ 4%). Most of the cost is building the transport dicts and
  serializing them.
- **The estimate is very accurate for ASCII**, within ±6% for every scenario with attributes.
- **It undercounts non-ASCII text by about 2×.** `json.dumps` writes each non-ASCII character as a `\uXXXX`
  escape (6 bytes, or 12 for an emoji), but the estimate counts 1 per character.

## The two estimates compared

|                          | JavaScript                                  | Python                                   |
| ------------------------ | ------------------------------------------- | ---------------------------------------- |
| Base size                | 156                                         | 210                                      |
| Span name                | 2 × length                                  | ignored (covered by the base)            |
| Per attribute            | 2 × (key + type + unit) + value             | 50 + value                               |
| String value             | 2 × length                                  | 1 × length                               |
| Number / boolean         | 8 / 4                                       | `len(str(value))`                        |
| Array                    | first item × length                         | `len(str(list))`                         |
| Links                    | 100 + first link's attributes, × count      | n/a                                      |
| Typical error, ASCII     | −29% to +91%                                | −12% to +6%                              |
| Non-ASCII error          | −10%                                        | −54%                                     |

The JS estimate leans on "2 bytes per character", which overcounts the usual ASCII content a lot. The Python
estimate counts 1 per character and a flat 50 bytes per attribute. That fits ASCII payloads closely, but misses the
6-byte `\uXXXX` escapes Python writes for non-ASCII text. Neither estimate is exact, but both are much cheaper than
measuring.

## Running it

Needs Node 20+ and Python 3.9+. There are no dependencies.

```sh
# JavaScript
node js/orchestrate.mjs        # full benchmark (~1–2 min)
node js/sizes.mjs              # accuracy table
node js/entries.mjs many_attrs # Object.entries vs for...in

# Python
python3 python/orchestrate.py  # full benchmark (~3 min)
python3 python/sizes.py        # accuracy table
```

Absolute numbers depend on your machine. The ratios between approaches should hold.
