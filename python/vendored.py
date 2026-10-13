# Copied from getsentry/sentry-python @ 7cb80948cbdefb10831740c23b49e56e348532a5
# MIT License, Copyright (c) 2018 Functional Software, Inc. dba Sentry
#
# - estimate_size:        sentry_sdk/_span_batcher.py  SpanBatcher._estimate_size
# - to_transport_format:  sentry_sdk/_span_batcher.py  SpanBatcher._to_transport_format
# - serialize_attribute:  sentry_sdk/utils.py          (safe_repr replaced by repr)
# - json_dumps:           sentry_sdk/utils.py
#
# Only type annotations were removed. The logic is unchanged.
import json


def estimate_size(item):
    # Rough estimate of serialized span size that's quick to compute.
    # 210 is the rough size of the payload without attributes, and then we
    # estimate the attributes separately.
    estimate = 210
    for value in (item.get("attributes") or {}).values():
        estimate += 50

        if isinstance(value, str):
            estimate += len(value)
        else:
            estimate += len(str(value))

    return estimate


def serialize_attribute(val):
    """Serialize attribute value to the transport format."""
    if isinstance(val, bool):
        return {"value": val, "type": "boolean"}
    if isinstance(val, int):
        return {"value": val, "type": "integer"}
    if isinstance(val, float):
        return {"value": val, "type": "double"}
    if isinstance(val, str):
        return {"value": val, "type": "string"}

    if isinstance(val, list):
        if not val:
            return {"value": [], "type": "array"}

        # Only lists of elements of a single type are supported
        ty = type(val[0])
        if ty in (int, str, bool, float) and all(type(v) is ty for v in val):
            return {"value": val, "type": "array"}

    return {"value": repr(val), "type": "string"}


def to_transport_format(item):
    res = {k: v for k, v in item.items() if k not in ("_segment_span",)}

    if item.get("attributes"):
        res["attributes"] = {
            k: serialize_attribute(v) for (k, v) in item["attributes"].items()
        }
    else:
        del res["attributes"]

    return res


def json_dumps(data):
    """Serialize data into a compact JSON representation encoded as UTF-8."""
    return json.dumps(data, allow_nan=False, separators=(",", ":")).encode("utf-8")
