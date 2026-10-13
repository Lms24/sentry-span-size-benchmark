// Builds the real sentry-javascript TS sources with esbuild. For each variant, an esbuild
// plugin patches every `log_item` / `metric` drop site in memory to also record a byte
// outcome. The sentry-javascript checkout is never modified.
import { readFileSync } from 'node:fs';
import path from 'node:path';

if (!process.env.SENTRY_JS_REPO) {
  throw new Error('Set SENTRY_JS_REPO to a sentry-javascript checkout (with `yarn install` done).');
}
export const REPO = path.resolve(process.env.SENTRY_JS_REPO);
// esbuild and @sentry/conventions are taken from here. Override when REPO is a git worktree without node_modules.
export const NODE_MODULES = path.resolve(process.env.SENTRY_JS_NODE_MODULES ?? path.join(REPO, 'node_modules'));

const CORE = path.join(REPO, 'packages/core/src');

// --- size helpers, one virtual module per variant -------------------------------------

const HELPERS = {
  // Same idea as estimateSerializedSpanSizeInBytes: 2 bytes per char, 8 per number.
  // Capture-time items still have raw attributes; transport items have typed attributes,
  // so those reuse the existing estimateTypedAttributesSizeInBytes.
  estimate: `
    import { estimateTypedAttributesSizeInBytes } from ${JSON.stringify(path.join(CORE, 'attributes.ts'))};
    function rawItemSize(text, attributes) {
      let weight = 100 + String(text).length * 2;
      for (const key in attributes) {
        const value = attributes[key];
        weight += key.length * 2;
        weight += typeof value === 'string' ? value.length * 2 : typeof value === 'number' ? 8 : typeof value === 'boolean' ? 4 : 100;
      }
      return weight;
    }
    export function logSize(log) { return rawItemSize(log.message, log.attributes); }
    export function metricSize(metric) { return rawItemSize(metric.name, metric.attributes); }
    export function containerSize(payload) {
      let weight = 0;
      for (const item of payload.items) {
        weight += 100 + String(item.body ?? item.name).length * 2 + estimateTypedAttributesSizeInBytes(item.attributes);
      }
      return weight;
    }
  `,
  // Exact: UTF-8 byte length of JSON.stringify, via TextEncoder (works in every runtime).
  // try/catch because raw capture-time attributes may contain cycles or BigInts.
  exact_textencoder: `
    function jsonBytes(value) {
      try {
        return new TextEncoder().encode(JSON.stringify(value)).length;
      } catch {
        return 0;
      }
    }
    export const logSize = jsonBytes;
    export const metricSize = jsonBytes;
    export const containerSize = jsonBytes;
  `,
  // Exact: same number, but counts UTF-8 bytes by hand instead of allocating a Uint8Array.
  exact_utf8count: `
    function utf8Length(str) {
      let bytes = 0;
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
        else bytes += 3;
      }
      return bytes;
    }
    function jsonBytes(value) {
      try {
        return utf8Length(JSON.stringify(value));
      } catch {
        return 0;
      }
    }
    export const logSize = jsonBytes;
    export const metricSize = jsonBytes;
    export const containerSize = jsonBytes;
  `,
};

// Same helpers as `estimate`, but estimateTypedAttributesSizeInBytes loops with for...in
// instead of Object.entries (see the span size benchmark).
HELPERS.estimate_forin = HELPERS.estimate;

export const VARIANTS = ['baseline', 'estimate', 'estimate_forin', 'exact_textencoder', 'exact_utf8count'];

const FORIN_PATCH = [
  'for (const [key, attr] of Object.entries(attributes)) {',
  'for (const key in attributes) {\n    const attr = attributes[key]!;',
];

// --- patches: every drop site that records log_item or metric ---------------------------

const IMPORT = "import { logSize as __logSize, metricSize as __metricSize, containerSize as __containerSize } from 'virtual:size';\n";

const PATCHES = {
  'logs/internal.ts': [
    [
      "client.recordDroppedEvent('callback_error', 'log_item', 1);",
      "client.recordDroppedEvent('callback_error', 'log_item', 1);\n    client.recordDroppedEvent('callback_error', 'log_byte', __logSize(processedLog));",
    ],
    [
      "client.recordDroppedEvent('before_send', 'log_item', 1);",
      "client.recordDroppedEvent('before_send', 'log_item', 1);\n    client.recordDroppedEvent('before_send', 'log_byte', __logSize(processedLog));",
    ],
  ],
  'metrics/internal.ts': [
    [
      "client.recordDroppedEvent('callback_error', 'metric', 1);",
      "client.recordDroppedEvent('callback_error', 'metric', 1);\n    client.recordDroppedEvent('callback_error', 'trace_metric_byte', __metricSize(enrichedMetric));",
    ],
    [
      "client.recordDroppedEvent('before_send', 'metric', 1);",
      "client.recordDroppedEvent('before_send', 'metric', 1);\n    client.recordDroppedEvent('before_send', 'trace_metric_byte', __metricSize(enrichedMetric));",
    ],
  ],
  // recordItemLoss covers ratelimit_backoff, send_error (413), network_error and queue_overflow.
  'transports/base.ts': [
    [
      "options.recordDroppedEvent(reason, dataCategory, typeof headers.item_count === 'number' ? headers.item_count : 1);",
      `options.recordDroppedEvent(reason, dataCategory, typeof headers.item_count === 'number' ? headers.item_count : 1);
    if (type === 'log' || type === 'trace_metric') {
      options.recordDroppedEvent(reason, type === 'log' ? 'log_byte' : 'trace_metric_byte', __containerSize(payload));
    }`,
    ],
  ],
};

export function variantPlugin(variant) {
  return {
    name: 'size-variant',
    setup(build) {
      build.onResolve({ filter: /^virtual:size$/ }, () => ({ path: 'virtual:size', namespace: 'size' }));
      build.onLoad({ filter: /.*/, namespace: 'size' }, () => ({
        contents: HELPERS[variant] ?? '',
        loader: 'js',
        resolveDir: CORE,
      }));
      if (variant === 'baseline') return;
      const patchSource = (file, patches) => {
        let src = readFileSync(file, 'utf8');
        for (const [from, to] of patches) {
          if (src.split(from).length !== 2) throw new Error(`patch target not found exactly once in ${file}: ${from}`);
          src = src.replace(from, to);
        }
        return src;
      };
      build.onLoad({ filter: /packages\/core\/src\/(logs|metrics|transports)\/(internal|base)\.ts$/ }, args => {
        const patches = PATCHES[path.relative(CORE, args.path)];
        if (!patches) return undefined;
        return { contents: IMPORT + patchSource(args.path, patches), loader: 'ts' };
      });
      if (variant === 'estimate_forin') {
        build.onLoad({ filter: /packages\/core\/src\/attributes\.ts$/ }, args => ({
          contents: patchSource(args.path, [FORIN_PATCH]),
          loader: 'ts',
        }));
      }
    },
  };
}

const WORKSPACE_PACKAGES = {
  '@sentry/core': 'packages/core/src/index.ts',
  '@sentry/core/browser': 'packages/core/src/browser.ts',
  '@sentry/browser-utils': 'packages/browser-utils/src/index.ts',
  '@sentry/browser': 'packages/browser/src/index.ts',
  '@sentry-internal/integration-shims': 'packages/integration-shims/src/index.ts',
};

/** Resolves workspace packages to their TS sources, so the build uses the checkout's current code. */
export const workspacePlugin = {
  name: 'workspace',
  setup(build) {
    build.onResolve({ filter: /^core-src\// }, args => ({ path: path.join(CORE, `${args.path.slice('core-src/'.length)}.ts`) }));
    build.onResolve({ filter: /^@sentry(-internal)?\// }, args => {
      const rel = WORKSPACE_PACKAGES[args.path];
      return rel ? { path: path.join(REPO, rel) } : undefined;
    });
  },
};

export function defines(debug) {
  return {
    __DEBUG_BUILD__: String(debug),
    __SENTRY_BROWSER_BUNDLE__: 'false',
    __SENTRY_SDK_VERSION__: '"0.0.0-bench"',
  };
}
