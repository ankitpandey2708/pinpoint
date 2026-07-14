import type { OverlayUrls } from './instrumentation/types';

/** All Pinpoint-owned browser assets and APIs live under this path prefix. */
export const PINPOINT_BASE = '/__pinpoint__';

export const OVERLAY_URLS: OverlayUrls = {
  css: `${PINPOINT_BASE}/overlay.css`,
  js: `${PINPOINT_BASE}/overlay.js`,
};

/** Top-level directory names never copied into a preview workspace. */
export const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  'data',
  '.pinpoint',
  '.github',
  '.ssh',
  '.aws',
  '.azure',
  '.vercel',
]);
