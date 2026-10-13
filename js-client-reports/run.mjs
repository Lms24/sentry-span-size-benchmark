// Usage: node --expose-gc run.mjs <variant>
// Times the real SDK drop paths for logs and metrics, one variant per process.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const variant = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = await import(path.join(here, 'dist', `${variant}.mjs`));

const POOL = 256;
const rnd = n => (Math.random() * n) | 0;
const word = n => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[rnd(26)]).join('');

function makeLog(large) {
  const attributes = {
    userId: rnd(1e6),
    route: `/api/${word(6)}/:id`,
    durationMs: Math.random() * 500,
    ok: Math.random() > 0.1,
    requestId: word(24),
  };
  if (large) for (let i = 0; i < 10; i++) attributes[`extra.${word(6)}`] = word(40);
  return {
    level: 'info',
    message: large ? `Processed payload ${word(2000)}` : `User ${rnd(1e6)} fetched ${word(8)} in ${rnd(500)}ms from ${word(12)}`,
    attributes,
  };
}

function makeMetric() {
  return {
    name: `http.server.${word(6)}.duration`,
    value: Math.random() * 500,
    type: 'distribution',
    unit: 'millisecond',
    attributes: { route: `/api/${word(6)}/:id`, method: 'GET', status: 200 },
  };
}

// Real serialized logs/metrics, as they sit in the flush buffer.
function collectSerialized(count, kind) {
  const out = [];
  const client = sdk.makeClient();
  const scope = sdk.getCurrentScope();
  for (let i = 0; i < count; i++) {
    if (kind === 'log') sdk._INTERNAL_captureLog(makeLog(false), scope, (_c, log) => out.push(log));
    else sdk._INTERNAL_captureMetric(makeMetric(), { scope, captureSerializedMetric: (_c, m) => out.push(m) });
  }
  void client;
  return out;
}

function makeTransport(client, mode) {
  let first = true;
  const makeRequest =
    mode === 'network_error'
      ? () => Promise.reject(new Error('Failed to fetch'))
      : () => {
          // first response sets a rate limit for every category, every later send hits ratelimit_backoff
          const res = first ? { statusCode: 429, headers: { 'x-sentry-rate-limits': '3600::organization', 'retry-after': null } } : {};
          first = false;
          return Promise.resolve(res);
        };
  return sdk.createTransport({ recordDroppedEvent: client.recordDroppedEvent.bind(client) }, makeRequest);
}

async function setupScenarios() {
  const smallLogs = Array.from({ length: POOL }, () => makeLog(false));
  const largeLogs = Array.from({ length: POOL }, () => makeLog(true));
  const metrics = Array.from({ length: POOL }, makeMetric);

  // Max flush sizes: 100 logs (MAX_LOG_BUFFER_SIZE), 1000 metrics (MAX_METRIC_BUFFER_SIZE).
  const logEnvelopes = Array.from({ length: 16 }, () => sdk.createLogEnvelope(collectSerialized(100, 'log')));
  const metricEnvelopes = Array.from({ length: 4 }, () => sdk.createMetricEnvelope(collectSerialized(1000, 'metric')));

  const transportClient = sdk.makeClient();
  const netTransport = makeTransport(transportClient, 'network_error');
  const rlTransport = makeTransport(transportClient, 'ratelimit');
  await rlTransport.send(logEnvelopes[0]);

  // Created last: makeClient() binds the client to the current scope, which the capture scenarios use.
  const logClient = sdk.makeClient({ beforeSendLog: () => null, beforeSendMetric: () => null });
  const scope = sdk.getCurrentScope();

  const sendAll = (transport, envelopes) => {
    let k = 0;
    return async () => {
      await transport.send(envelopes[k++ % envelopes.length]).then(
        () => {},
        () => {},
      );
    };
  };
  let i = 0;
  return {
    'capture: log before_send (small)': { sync: () => sdk._INTERNAL_captureLog(smallLogs[i++ % POOL], scope) },
    'capture: log before_send (2 KB)': { sync: () => sdk._INTERNAL_captureLog(largeLogs[i++ % POOL], scope) },
    'capture: metric before_send': { sync: () => sdk._INTERNAL_captureMetric(metrics[i++ % POOL], { scope }) },
    'transport: network_error, 100 logs': { async: sendAll(netTransport, logEnvelopes) },
    'transport: network_error, 1000 metrics': { async: sendAll(netTransport, metricEnvelopes) },
    'transport: ratelimit_backoff, 100 logs': { async: sendAll(rlTransport, logEnvelopes) },
    'transport: ratelimit_backoff, 1000 metrics': { async: sendAll(rlTransport, metricEnvelopes) },
    _clients: [logClient, transportClient],
  };
}

async function runBatch(s, iters) {
  const t0 = process.hrtime.bigint();
  if (s.sync) for (let k = 0; k < iters; k++) s.sync();
  else for (let k = 0; k < iters; k++) await s.async();
  return Number(process.hrtime.bigint() - t0);
}

const scenarios = await setupScenarios();
const clients = scenarios._clients;
delete scenarios._clients;

const warmEnd = Date.now() + 1500;
while (Date.now() < warmEnd) for (const s of Object.values(scenarios)) await runBatch(s, s.sync ? 500 : 20);

const SAMPLES = 40;
const TARGET_NS = 20e6;
const out = {};
for (const [name, s] of Object.entries(scenarios)) {
  let iters = s.sync ? 500 : 10;
  while ((await runBatch(s, iters)) < TARGET_NS / 4) iters *= 2;
  iters = Math.max(10, Math.round((iters * TARGET_NS) / (await runBatch(s, iters))));
  global.gc?.();
  const samples = [];
  for (let k = 0; k < SAMPLES; k++) samples.push((await runBatch(s, iters)) / iters);
  samples.sort((a, b) => a - b);
  out[name] = { median: samples[SAMPLES >> 1] };
}

// Sanity check: byte outcomes are recorded only by the patched variants.
const outcomes = Object.assign({}, ...clients.map(c => c.outcomes()));
const byteKeys = Object.keys(outcomes).filter(k => k.endsWith('_byte')).sort();
process.stdout.write(JSON.stringify({ variant, out, byteKeys }) + '\n');
