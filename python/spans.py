"""Pools of distinct, realistic SpanJSON dicts, as SpanBatcher.add() receives them.

Attribute values are raw Python values (not yet typed); sentry-python converts them
to the typed transport format only when flushing.
"""

import random

LOWER = "abcdefghijklmnopqrstuvwxyz "
UNICODE = "äöüßéèñ日本語中文한국어🚀 "


def hexs(n):
    return "".join(random.choice("0123456789abcdef") for _ in range(n))


def text(n, alphabet=LOWER):
    return "".join(random.choice(alphabet) for _ in range(n))


class FakeStreamedSpan:
    """Stand-in for the StreamedSpan that real SpanJSON dicts reference."""


SEGMENT = FakeStreamedSpan()


def base(name, attributes, is_segment=False):
    start = 1740000000 + random.random() * 1000
    span = {
        "trace_id": hexs(32),
        "span_id": hexs(16),
        "name": name,
        "status": "ok",
        "is_segment": is_segment,
        "start_timestamp": start,
        "end_timestamp": start + random.random(),
        "attributes": attributes,
        "_segment_span": SEGMENT,
    }
    if not is_segment:
        span["parent_span_id"] = hexs(16)
    return span


def common_attrs():
    return {
        "sentry.origin": random.choice(["auto.http.asgi", "auto.db.sqlalchemy", "manual"]),
        "sentry.op": random.choice(["http.server", "db", "http.client"]),
        "sentry.release": "my-app@1.2.%d" % random.randrange(100),
        "sentry.environment": "production",
        "sentry.sdk.name": "sentry.python",
        "sentry.sdk.version": "3.0.0",
        "sentry.segment.name": "GET /api/users/{id}",
        "sentry.segment.id": hexs(16),
    }


def minimal():
    return base("span " + text(8), {})


def http_server():
    uid = random.randrange(10**6)
    return base(
        "GET /api/users/{id}",
        {
            **common_attrs(),
            "http.request.method": "GET",
            "http.response.status_code": 200,
            "http.route": "/api/users/{id}",
            "url.full": "https://example.com/api/users/%d?page=1&limit=100" % uid,
            "url.path": "/api/users/%d" % uid,
            "url.scheme": "https",
            "server.address": "example.com",
            "server.port": 443,
            "client.address": "10.0.%d.%d" % (random.randrange(255), random.randrange(255)),
            "user_agent.original": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "network.protocol.version": "1.1",
            "http.request.body.size": random.randrange(10**4),
            "http.response.body.size": random.randrange(10**5),
            "sentry.sample_rate": 0.25,
        },
        is_segment=True,
    )


def db_query():
    return base(
        "SELECT users",
        {
            **common_attrs(),
            "db.system.name": "postgresql",
            "db.namespace": "app",
            "db.operation.name": "SELECT",
            "db.query.text": "SELECT u.id, u.email, u.name, o.id AS order_id, o.total FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.id = $1 AND o.created_at > $2 "
            + text(300),
            "server.address": "db.internal",
            "server.port": 5432,
        },
    )


def gen_ai_large():
    import json

    return base(
        "chat gpt-4o",
        {
            **common_attrs(),
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.request.messages": json.dumps([{"role": "user", "content": text(8000)}]),
            "gen_ai.response.text": text(4000),
            "gen_ai.usage.input_tokens": 2000,
            "gen_ai.usage.output_tokens": 1000,
            "gen_ai.request.temperature": 0.7,
            "gen_ai.response.streaming": True,
        },
    )


def many_attrs():
    attributes = common_attrs()
    for n in range(60):
        attributes["custom.attr_%d" % n] = n * 1000 if n % 3 == 0 else text(20) if n % 3 == 1 else text(10)
    attributes["custom.array"] = [text(10), text(10), text(10)]
    return base("process job", attributes)


def unicode():
    return base(
        "Benutzer laden – ユーザー取得 🚀",
        {
            **common_attrs(),
            "db.query.text": "SELECT * FROM benutzer WHERE name = " + text(200, UNICODE),
            "user.name": text(40, "ÄÖÜäöüß日本語"),
        },
    )


SCENARIOS = {
    "minimal": minimal,
    "http_server": http_server,
    "db_query": db_query,
    "gen_ai_large": gen_ai_large,
    "many_attrs": many_attrs,
    "unicode": unicode,
}


def make_pool(name, size):
    return [SCENARIOS[name]() for _ in range(size)]
