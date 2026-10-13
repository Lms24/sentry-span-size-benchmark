"""Usage: python run.py <variant>

Times the real sentry-python drop paths for logs and metrics, one variant per process.
Needs urllib3 + certifi (e.g. the sentry-python checkout's .venv).
"""

import copy
import gc
import json
import os
import random
import string
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VARIANT = sys.argv[1]
sys.path.insert(0, os.path.join(HERE, "variants", VARIANT))

import sentry_sdk  # noqa: E402
from sentry_sdk._log_batcher import LogBatcher  # noqa: E402
from sentry_sdk._metrics_batcher import MetricsBatcher  # noqa: E402
from sentry_sdk.envelope import Envelope, Item, PayloadRef  # noqa: E402

POOL = 256
SAMPLES = 40
TARGET_NS = 20_000_000


def word(n):
    return "".join(random.choice(string.ascii_lowercase) for _ in range(n))


def log_args(large):
    attributes = {
        "route": "/api/%s/:id" % word(6),
        "ok": random.random() > 0.1,
        "request_id": word(24),
    }
    if large:
        for _ in range(10):
            attributes["extra." + word(6)] = word(40)
        return ("Processed payload " + word(2000),), {"attributes": attributes}
    return (
        ("User {user_id} fetched {thing} in {ms}ms from {source}",),
        {
            "user_id": random.randrange(10**6),
            "thing": word(8),
            "ms": random.random() * 500,
            "source": word(12),
            "attributes": attributes,
        },
    )


def metric_args():
    return (
        ("http.server.%s.duration" % word(6), random.random() * 500),
        {"unit": "millisecond", "attributes": {"route": "/api/%s/:id" % word(6), "method": "GET", "status": 200}},
    )


def main():
    client_opts = dict(
        dsn="http://public@127.0.0.1:9/1",
        release="my-app@1.2.3",
        environment="production",
        enable_logs=True,
        send_client_reports=True,
        before_send_log=lambda log, hint: None,
        before_send_metric=lambda metric, hint: None,
    )
    sentry_sdk.init(**client_opts)
    client = sentry_sdk.get_client()
    transport = client.transport

    small_logs = [log_args(False) for _ in range(POOL)]
    large_logs = [log_args(True) for _ in range(POOL)]
    metrics = [metric_args() for _ in range(POOL)]

    # Collect real, fully enriched Log/Metric dicts as the batchers would receive them.
    collected = {"log": [], "metric": []}
    client.options["before_send_log"] = lambda log, hint: collected["log"].append(copy.deepcopy(log))
    client.options["before_send_metric"] = lambda m, hint: collected["metric"].append(copy.deepcopy(m))
    for a, kw in small_logs:
        sentry_sdk.logger.info(*a, **copy.deepcopy(kw))
    for _ in range(4):
        for a, kw in metrics:
            sentry_sdk.metrics.distribution(*a, **kw)
    client.options["before_send_log"] = client_opts["before_send_log"]
    client.options["before_send_metric"] = client_opts["before_send_metric"]
    raw_logs, raw_metrics = collected["log"], collected["metric"]
    assert raw_logs and raw_metrics, "collecting logs/metrics failed"

    # Transport-format payloads, as the batchers build them on flush (100 logs / 1000 metrics max).
    log_items = [LogBatcher._to_transport_format(copy.deepcopy(l)) for l in raw_logs]
    metric_items = [MetricsBatcher._to_transport_format(copy.deepcopy(m)) for m in raw_metrics]
    log_payloads = [random.sample(log_items, 100) for _ in range(16)]
    metric_payloads = [[random.choice(metric_items) for _ in range(1000)] for _ in range(4)]

    def envelope(ty, content_type, items):
        # Fresh Item/PayloadRef every time: PayloadRef caches its bytes.
        return Envelope(
            items=[
                Item(
                    type=ty,
                    content_type=content_type,
                    headers={"item_count": len(items)},
                    payload=PayloadRef(json={"version": 2, "items": items}),
                )
            ]
        )

    def log_env(k):
        return envelope("log", LogBatcher.CONTENT_TYPE, log_payloads[k % len(log_payloads)])

    def metric_env(k):
        return envelope("trace_metric", MetricsBatcher.CONTENT_TYPE, metric_payloads[k % len(metric_payloads)])

    def network_error(make_env):
        def op(k):
            env = make_env(k)
            env.serialize()  # the send path serializes before the request fails
            transport._handle_request_error(envelope=env, loss_reason="network")

        return op

    def ratelimited(make_env):
        def op(k):
            transport._disabled_until[None] = far_future
            transport._prepare_envelope(make_env(k))

        return op

    from datetime import datetime, timedelta, timezone

    far_future = datetime.now(timezone.utc) + timedelta(days=1)

    def full_batcher(cls, items):
        b = cls(capture_func=lambda env: None, record_lost_func=client.log_batcher._record_lost_func)
        b.FLUSH_WAIT_TIME = 10**9  # never flush during the benchmark
        b._buffer = [copy.deepcopy(items[0])] * b.MAX_BEFORE_DROP
        return b

    log_batcher = full_batcher(LogBatcher, raw_logs)
    metric_batcher = full_batcher(MetricsBatcher, raw_metrics)

    def call_log(pool):
        return lambda k: sentry_sdk.logger.info(*pool[k % POOL][0], **pool[k % POOL][1])

    scenarios = {
        "capture: log before_send (small)": call_log(small_logs),
        "capture: log before_send (2 KB)": call_log(large_logs),
        "capture: metric before_send": lambda k: sentry_sdk.metrics.distribution(*metrics[k % POOL][0], **metrics[k % POOL][1]),
        "batcher: log queue_overflow": lambda k: log_batcher.add(raw_logs[k % len(raw_logs)]),
        "batcher: metric queue_overflow": lambda k: metric_batcher.add(raw_metrics[k % len(raw_metrics)]),
        "transport: network_error, 100 logs": network_error(log_env),
        "transport: network_error, 1000 metrics": network_error(metric_env),
        "transport: ratelimit_backoff, 100 logs": ratelimited(log_env),
        "transport: ratelimit_backoff, 1000 metrics": ratelimited(metric_env),
    }

    def run_batch(op, iters):
        t0 = time.perf_counter_ns()
        for k in range(iters):
            op(k)
        return time.perf_counter_ns() - t0

    warm_end = time.monotonic() + 1.0
    while time.monotonic() < warm_end:
        for op in scenarios.values():
            run_batch(op, 5)

    out = {}
    for name, op in scenarios.items():
        iters = 2
        while run_batch(op, iters) < TARGET_NS / 4:
            iters *= 2
        iters = max(2, round(iters * TARGET_NS / run_batch(op, iters)))
        gc.collect()
        samples = sorted(run_batch(op, iters) / iters for _ in range(SAMPLES))
        out[name] = {"median": samples[SAMPLES // 2]}

    # Sanity check: which byte outcomes did this variant record?
    byte_keys = sorted({"%s:%s" % (r, c) for (c, r) in transport._discarded_events if c.endswith("_byte")})
    print(json.dumps({"variant": VARIANT, "out": out, "byteKeys": byte_keys}), flush=True)
    os._exit(0)  # skip SDK shutdown/flush (it would try to reach the fake DSN)


if __name__ == "__main__":
    main()
