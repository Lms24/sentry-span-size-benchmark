// Generates pools of distinct, realistic SerializedStreamedSpan objects.
const hex = n => {
  let s = '';
  for (let i = 0; i < n; i++) s += ((Math.random() * 16) | 0).toString(16);
  return s;
};
const rnd = arr => arr[(Math.random() * arr.length) | 0];
const str = (n, alphabet = 'abcdefghijklmnopqrstuvwxyz ') => {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
};

function base(name, extra = {}) {
  const start = 1740000000 + Math.random() * 1000;
  return {
    trace_id: hex(32),
    span_id: hex(16),
    parent_span_id: hex(16),
    name,
    start_timestamp: start,
    end_timestamp: start + Math.random(),
    status: 'ok',
    is_segment: false,
    attributes: {},
    ...extra,
  };
}

const s = value => ({ type: 'string', value });
const i = value => ({ type: 'integer', value });
const d = value => ({ type: 'double', value });
const b = value => ({ type: 'boolean', value });

const commonAttrs = () => ({
  'sentry.origin': s(rnd(['auto.http.otel.http', 'auto.db.otel.postgres', 'manual'])),
  'sentry.op': s(rnd(['http.server', 'db', 'http.client'])),
  'sentry.release': s('my-app@1.2.' + ((Math.random() * 100) | 0)),
  'sentry.environment': s('production'),
  'sentry.sdk.name': s('sentry.javascript.node'),
  'sentry.sdk.version': s('10.20.0'),
  'sentry.segment.name': s('GET /api/users/:id'),
  'sentry.segment.id': s(hex(16)),
});

export const scenarios = {
  minimal: () => base('span ' + str(8), { attributes: {} }),

  http_server: () =>
    base('GET /api/users/:id', {
      is_segment: true,
      parent_span_id: undefined,
      attributes: {
        ...commonAttrs(),
        'http.request.method': s('GET'),
        'http.response.status_code': i(200),
        'http.route': s('/api/users/:id'),
        'url.full': s('https://example.com/api/users/' + ((Math.random() * 1e6) | 0) + '?page=1&limit=100'),
        'url.path': s('/api/users/' + ((Math.random() * 1e6) | 0)),
        'url.scheme': s('https'),
        'server.address': s('example.com'),
        'server.port': i(443),
        'client.address': s('10.0.' + ((Math.random() * 255) | 0) + '.' + ((Math.random() * 255) | 0)),
        'user_agent.original': s(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        ),
        'network.protocol.version': s('1.1'),
        'http.request.body.size': i((Math.random() * 1e4) | 0),
        'http.response.body.size': i((Math.random() * 1e5) | 0),
        'sentry.sample_rate': d(0.25),
      },
    }),

  db_query: () =>
    base('SELECT users', {
      attributes: {
        ...commonAttrs(),
        'db.system.name': s('postgresql'),
        'db.namespace': s('app'),
        'db.operation.name': s('SELECT'),
        'db.query.text': s(
          'SELECT u.id, u.email, u.name, o.id AS order_id, o.total FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.id = $1 AND o.created_at > $2 ' +
            str(300),
        ),
        'server.address': s('db.internal'),
        'server.port': i(5432),
      },
    }),

  gen_ai_large: () =>
    base('chat gpt-4o', {
      attributes: {
        ...commonAttrs(),
        'gen_ai.operation.name': s('chat'),
        'gen_ai.request.model': s('gpt-4o'),
        'gen_ai.request.messages': s(JSON.stringify([{ role: 'user', content: str(8000) }])),
        'gen_ai.response.text': s(str(4000)),
        'gen_ai.usage.input_tokens': i(2000),
        'gen_ai.usage.output_tokens': i(1000),
        'gen_ai.request.temperature': d(0.7),
        'gen_ai.response.streaming': b(true),
      },
    }),

  many_attrs: () => {
    const attributes = commonAttrs();
    for (let n = 0; n < 60; n++) {
      attributes['custom.attr_' + n] = n % 3 === 0 ? i(n * 1000) : n % 3 === 1 ? s(str(20)) : s([str(10), str(10)][0]);
    }
    attributes['custom.array'] = { type: 'array', value: [str(10), str(10), str(10)] };
    return base('process job', { attributes });
  },

  with_links: () =>
    base('consume batch', {
      attributes: { ...commonAttrs(), 'messaging.system': s('kafka'), 'messaging.batch.message_count': i(5) },
      links: Array.from({ length: 5 }, () => ({
        trace_id: hex(32),
        span_id: hex(16),
        sampled: true,
        attributes: { 'sentry.link.type': s('previous_trace'), 'messaging.message.id': s(hex(24)) },
      })),
    }),

  unicode: () =>
    base('Benutzer laden – ユーザー取得 🚀', {
      attributes: {
        ...commonAttrs(),
        'db.query.text': s('SELECT * FROM benutzer WHERE name = ' + str(200, 'äöüßéèñ日本語中文한국어🚀 ')),
        'user.name': s(str(40, 'ÄÖÜäöüß日本語')),
      },
    }),
};

export function makePool(scenario, size) {
  const gen = scenarios[scenario];
  return Array.from({ length: size }, () => {
    const span = gen();
    // match real serialized spans: undefined keys are stripped before buffering
    if (span.parent_span_id === undefined) delete span.parent_span_id;
    return span;
  });
}
