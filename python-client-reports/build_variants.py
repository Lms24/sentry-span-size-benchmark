"""Copies sentry_sdk from a sentry-python checkout into variants/<name>/ and patches
every log/metric drop site per variant. The checkout itself is never modified.

Usage: SENTRY_PY_REPO=/path/to/sentry-python python build_variants.py
"""

import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("SENTRY_PY_REPO")

VARIANTS = ["none", "estimate", "exact"]

SIZE_MODULE = '''
from sentry_sdk.utils import json_dumps


def _estimate(text, attributes):
    # Same style as SpanBatcher._estimate_size: 1 per char, 50 per attribute.
    estimate = 100 + len(text)
    for value in attributes.values():
        estimate += 50 + (len(value) if isinstance(value, str) else len(str(value)))
    return estimate


def estimate_log(log):
    return _estimate(str(log["body"]), log.get("attributes") or {})


def estimate_metric(metric):
    return _estimate(metric["name"], metric.get("attributes") or {})


def estimate_container(payload):
    # Transport items already have typed attributes: {"value": ..., "type": ...}
    estimate = 0
    for item in payload["items"]:
        estimate += 100 + len(item.get("body") or item.get("name") or "")
        for attr in item["attributes"].values():
            value = attr["value"]
            estimate += 50 + (len(value) if isinstance(value, str) else len(str(value)))
    return estimate


def exact_log(log):
    from sentry_sdk._log_batcher import LogBatcher

    return len(json_dumps(LogBatcher._to_transport_format(log)))


def exact_metric(metric):
    from sentry_sdk._metrics_batcher import MetricsBatcher

    return len(json_dumps(MetricsBatcher._to_transport_format(metric)))
'''

TRANSPORT_LOG_BYTE = """            elif data_category == "log_item" and item:
                # Also record size of lost logs in bytes
                bytes_size = len(item.get_bytes())
                self.record_lost_event(reason, "log_byte", quantity=bytes_size)
"""

LOG_RECORD_LOST = '''    def _record_lost(self, item: "Log") -> None:
        # Construct log envelope item without sending it to report lost bytes
        log_item = Item(
            type=self.TYPE,
            content_type=self.CONTENT_TYPE,
            headers={
                "item_count": 1,
            },
            payload=PayloadRef(
                json={
                    "version": 2,
                    "items": [self._to_transport_format(item)],
                }
            ),
        )

        self._record_lost_func(
            reason="queue_overflow",
            data_category="log_item",
            item=log_item,
            quantity=1,
        )
'''

METRIC_RECORD_LOST = """        self._record_lost_func(
            reason="queue_overflow",
            data_category="trace_metric",
            quantity=1,
        )
"""


def client_site(reason, category):
    return f"""                        self.transport.record_lost_event(
                            "{reason}", data_category="{category}"
                        )
"""


def client_patches(kind):
    patches = []
    for reason in ("callback_error", "before_send"):
        for category, byte_category, fn in (
            ("log_item", "log_byte", "log"),
            ("trace_metric", "trace_metric_byte", "metric"),
        ):
            site = client_site(reason, category)
            patches.append(
                (
                    site,
                    site
                    + f"""                        self.transport.record_lost_event(
                            "{reason}", data_category="{byte_category}", quantity=_size.{kind}_{fn}(telemetry)
                        )
""",
                )
            )
    return patches


def patches_for(variant):
    # sentry-python already records an exact log_byte in the transport and in LogBatcher._record_lost.
    # `none` removes it, so every variant is measured against "no byte outcomes at all".
    if variant == "none":
        return {
            "transport.py": [(TRANSPORT_LOG_BYTE, TRANSPORT_LOG_BYTE.replace(
                '                self.record_lost_event(reason, "log_byte", quantity=bytes_size)\n',
                "                pass\n").replace("                bytes_size = len(item.get_bytes())\n", ""))],
            "_log_batcher.py": [(LOG_RECORD_LOST, '''    def _record_lost(self, item: "Log") -> None:
        self._record_lost_func(reason="queue_overflow", data_category="log_item", quantity=1)
''')],
        }

    kind = variant  # "estimate" or "exact"
    if kind == "estimate":
        transport_size = "_size.estimate_container(item.payload.json)"
        transport_log = TRANSPORT_LOG_BYTE.replace("len(item.get_bytes())", transport_size)
        metric_size = transport_size
        log_lost = '''    def _record_lost(self, item: "Log") -> None:
        self._record_lost_func(reason="queue_overflow", data_category="log_item", quantity=1)
        self._record_lost_func(
            reason="queue_overflow", data_category="log_byte", quantity=_size.estimate_log(item)
        )
'''
    else:
        transport_log = TRANSPORT_LOG_BYTE
        metric_size = "len(item.get_bytes())"
        log_lost = LOG_RECORD_LOST  # already exact today

    transport_new = (
        transport_log
        + f"""            elif data_category == "trace_metric" and item:
                self.record_lost_event(reason, "trace_metric_byte", quantity={metric_size})
"""
    )
    return {
        "transport.py": [(TRANSPORT_LOG_BYTE, transport_new)],
        "_log_batcher.py": [(LOG_RECORD_LOST, log_lost)],
        "_metrics_batcher.py": [
            (
                METRIC_RECORD_LOST,
                METRIC_RECORD_LOST
                + f"""        self._record_lost_func(
            reason="queue_overflow", data_category="trace_metric_byte", quantity=_size.{kind}_metric(item)
        )
""",
            )
        ],
        "client.py": client_patches(kind),
    }


def build(variant):
    dest = os.path.join(HERE, "variants", variant, "sentry_sdk")
    shutil.rmtree(os.path.dirname(dest), ignore_errors=True)
    shutil.copytree(os.path.join(REPO, "sentry_sdk"), dest, ignore=shutil.ignore_patterns("__pycache__"))
    with open(os.path.join(dest, "_size.py"), "w") as f:
        f.write(SIZE_MODULE)
    for rel, patches in patches_for(variant).items():
        path = os.path.join(dest, rel)
        with open(path) as f:
            src = f.read()
        for old, new in patches:
            if src.count(old) != 1:
                raise SystemExit(f"{variant}: patch target not found exactly once in {rel}:\n{old}")
            src = src.replace(old, new)
        src = "from sentry_sdk import _size\n" + src if "_size." in src and rel != "_size.py" else src
        with open(path, "w") as f:
            f.write(src)


if __name__ == "__main__":
    if not REPO:
        raise SystemExit("Set SENTRY_PY_REPO to a sentry-python checkout.")
    for v in VARIANTS:
        build(v)
    print("built", ", ".join(VARIANTS), "into variants/")
