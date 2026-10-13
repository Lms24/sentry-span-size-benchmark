import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_MODULES, VARIANTS, defines, variantPlugin, workspacePlugin } from './variants.mjs';

const esbuild = createRequire(path.join(NODE_MODULES, 'x.js'))('esbuild');
const here = path.dirname(fileURLToPath(import.meta.url));

for (const variant of VARIANTS) {
  await esbuild.build({
    entryPoints: [path.join(here, 'harness-entry.ts')],
    outfile: path.join(here, 'dist', `${variant}.mjs`),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    nodePaths: [NODE_MODULES],
    define: defines(false),
    plugins: [workspacePlugin, variantPlugin(variant)],
    logLevel: 'error',
  });
}
console.log(`built ${VARIANTS.join(', ')} into dist/`);
