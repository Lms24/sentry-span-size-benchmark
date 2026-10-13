// Minified + gzip/brotli size of browser bundles for every variant, mirroring the
// @sentry/browser entries in sentry-javascript's .size-limit.js.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NODE_MODULES, VARIANTS, defines, variantPlugin, workspacePlugin } from './variants.mjs';

const esbuild = createRequire(path.join(NODE_MODULES, 'x.js'))('esbuild');

const ENTRIES = {
  'init (all bundles: transport only)': ['init'],
  'init, logger': ['init', 'logger'],
  'init, metrics': ['init', 'metrics'],
  'init, metrics, logger': ['init', 'metrics', 'logger'],
  'init, tracing + span streaming, metrics, logger': [
    'init',
    'browserTracingIntegration',
    'spanStreamingIntegration',
    'metrics',
    'logger',
  ],
};

async function measure(variant, imports) {
  const result = await esbuild.build({
    stdin: {
      contents: `import { ${imports.join(', ')} } from '@sentry/browser';\nconsole.log(${imports.join(', ')});`,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    treeShaking: true,
    nodePaths: [NODE_MODULES],
    define: defines(false),
    plugins: [workspacePlugin, variantPlugin(variant)],
    logLevel: 'error',
  });
  const code = result.outputFiles[0].contents;
  return {
    min: code.length,
    gzip: gzipSync(code, { level: 9 }).length,
    brotli: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

const rows = [];
for (const [name, imports] of Object.entries(ENTRIES)) {
  const sizes = {};
  for (const variant of VARIANTS) sizes[variant] = await measure(variant, imports);
  rows.push({ name, sizes });
}

const fmt = (n, base) => (base === undefined ? `${n}` : `${n - base >= 0 ? '+' : ''}${n - base}`);
for (const metric of ['gzip', 'brotli', 'min']) {
  console.log(`\n## ${metric} bytes (variants as delta vs baseline)`);
  console.log(['entry'.padEnd(50), ...VARIANTS.map(v => v.padStart(18))].join(''));
  for (const { name, sizes } of rows) {
    const base = sizes.baseline[metric];
    console.log(
      [name.padEnd(50), ...VARIANTS.map(v => fmt(sizes[v][metric], v === 'baseline' ? undefined : base).padStart(18))].join(''),
    );
  }
}
