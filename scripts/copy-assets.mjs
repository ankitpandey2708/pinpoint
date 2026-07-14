/*
 * Copy the runtime static assets that `tsc` does not emit into `dist`, so the
 * published package is self-contained: the server resolves overlay/dashboard
 * files relative to its own compiled location (see assetDir in
 * src/platform/server.ts), and `files: ["dist"]` ships only `dist`. Run after
 * `tsc` (and after build-overlay.mjs, which produces overlay.bundle.js).
 */
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ship the served static assets (overlay.css/.bundle.js, dashboard.html/.css/.js)
// but skip build inputs: TypeScript sources (tsc already compiled them) and
// overlay.client.js (the browser source that build-overlay.mjs bundles into
// overlay.bundle.js — it is never served).
const isBuildInput = (src) => /\.tsx?$/.test(src) || src.endsWith('overlay.client.js');

for (const rel of [join('preview', 'overlay'), join('feedback', 'dashboard')]) {
  cpSync(join(root, 'src', rel), join(root, 'dist', rel), {
    recursive: true,
    filter: (src) => !isBuildInput(src),
  });
}

// eslint-disable-next-line no-console
console.log('copied static assets to dist');
