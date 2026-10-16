import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const version =
  process.env.APP_VERSION ||
  JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8')).version;

// ws is CommonJS and calls require('events') etc.; an ESM bundle needs a real require.
const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
].join('\n');

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cortex-worker.mjs',
  define: { __WORKER_VERSION__: JSON.stringify(version) },
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: banner },
});

mkdirSync('dist', { recursive: true });
writeFileSync('dist/cortex-worker.version', `${version}\n`);
console.log(`built cortex-worker ${version}`);
