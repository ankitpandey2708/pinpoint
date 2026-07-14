/*
 * Bundle the review overlay client (+ element-source) into a single browser
 * IIFE served at /__pinpoint__/overlay.bundle.js. Run before `dev`/`build` — the
 * server serves the generated bundle; the source is overlay.client.js.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const overlayDir = join(here, '..', 'src', 'preview', 'overlay');

await build({
  entryPoints: [join(overlayDir, 'overlay.client.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2019',
  legalComments: 'none',
  outfile: join(overlayDir, 'overlay.bundle.js'),
});

// eslint-disable-next-line no-console
console.log('built overlay.bundle.js');
