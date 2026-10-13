// Bundled once per variant. Exposes the real SDK code paths that record log/metric drops.
import {
  _INTERNAL_captureLog,
  _INTERNAL_captureMetric,
  Client,
  createTransport,
  getCurrentScope,
  resolvedSyncPromise,
  setCurrentClient,
} from '@sentry/core';
// `core-src/*` resolves to packages/core/src/* (see workspacePlugin)
import { createLogEnvelope } from 'core-src/logs/envelope';
import { createMetricEnvelope } from 'core-src/metrics/envelope';

class BenchClient extends Client<any> {
  public eventFromException(): PromiseLike<any> {
    return resolvedSyncPromise({});
  }
  public eventFromMessage(): PromiseLike<any> {
    return resolvedSyncPromise({});
  }
  public outcomes(): Record<string, number> {
    return (this as any)._outcomes;
  }
}

export function makeClient(options: Record<string, unknown> = {}): BenchClient {
  const client = new BenchClient({
    dsn: 'https://public@o1.ingest.sentry.io/1',
    integrations: [],
    sendClientReports: true,
    enableLogs: true,
    release: 'my-app@1.2.3',
    environment: 'production',
    stackParser: () => [],
    transport: () => createTransport({ recordDroppedEvent: () => undefined }, () => resolvedSyncPromise({})),
    _metadata: { sdk: { name: 'sentry.javascript.browser', version: '10.20.0' } },
    ...options,
  });
  setCurrentClient(client);
  client.init();
  return client;
}

export { _INTERNAL_captureLog, _INTERNAL_captureMetric, createLogEnvelope, createMetricEnvelope, createTransport, getCurrentScope };
