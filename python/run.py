"""Usage: python3 run.py <candidate>

One candidate per process, to match the JS setup. Unlike timeit, the garbage
collector stays enabled, so the cost of the allocations each approach makes counts.
"""

import gc
import json
import random
import sys
import time

from spans import SCENARIOS, make_pool
from vendored import estimate_size, json_dumps, to_transport_format

CANDIDATES = {
    "estimate": estimate_size,
    # Exact: the bytes sentry-python puts on the wire for this span.
    "exact_bytes": lambda span: len(json_dumps(to_transport_format(span))),
    # Same number as exact_bytes (json.dumps escapes non-ASCII by default, so the
    # str is pure ASCII), but skips the .encode("utf-8") copy.
    "exact_str_len": lambda span: len(
        json.dumps(to_transport_format(span), allow_nan=False, separators=(",", ":"))
    ),
}

POOL = 1024
SAMPLES = 40
TARGET_NS = 20_000_000


def run_batch(fn, pool, iters):
    n = len(pool)
    sink = 0
    t0 = time.perf_counter_ns()
    for k in range(iters):
        sink += fn(pool[k % n])
    return time.perf_counter_ns() - t0, sink


def main():
    name = sys.argv[1]
    fn = CANDIDATES[name]
    random.seed()

    pools = {n: make_pool(n, POOL) for n in SCENARIOS}
    per = POOL // len(SCENARIOS)
    mixed = [s for n in SCENARIOS for s in pools[n][:per]]
    random.shuffle(mixed)
    pools["mixed"] = mixed

    total_sink = 0
    warm_end = time.monotonic() + 1.0
    while time.monotonic() < warm_end:
        for pool in pools.values():
            total_sink += run_batch(fn, pool, 500)[1]

    out = {}
    for scenario, pool in pools.items():
        iters = 200
        while run_batch(fn, pool, iters)[0] < TARGET_NS / 4:
            iters *= 2
        elapsed, _ = run_batch(fn, pool, iters)
        iters = max(200, round(iters * TARGET_NS / elapsed))
        gc.collect()
        samples = []
        for _ in range(SAMPLES):
            elapsed, sink = run_batch(fn, pool, iters)
            total_sink += sink
            samples.append(elapsed / iters)
        samples.sort()
        out[scenario] = {
            "median": samples[SAMPLES // 2],
            "p10": samples[SAMPLES // 10],
            "p90": samples[SAMPLES * 9 // 10],
        }

    print(json.dumps({"name": name, "out": out, "sink": total_sink % 7}))


if __name__ == "__main__":
    main()
