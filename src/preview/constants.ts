import type { OverlayUrls } from './instrumentation/types';

/** All Pinpoint-owned browser assets and APIs live under this path prefix. */
export const PINPOINT_BASE = '/__pinpoint__';

export const OVERLAY_URLS: OverlayUrls = {
  css: `${PINPOINT_BASE}/overlay.css`,
  js: `${PINPOINT_BASE}/overlay.bundle.js`,
};

