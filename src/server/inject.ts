import { OVERLAY_URLS } from '../preview/constants';

export interface OverlayContext {
  projectId: string;
  reviewKey: string;
  route: string;
}

/** Inline config the browser overlay reads on boot. Only non-sensitive fields. */
export function overlayConfigScript(ctx: OverlayContext): string {
  const config = JSON.stringify({
    projectId: ctx.projectId,
    reviewKey: ctx.reviewKey,
    route: ctx.route,
    apiBase: '/api',
  });
  return `<script data-pinpoint-ui="1">window.__PINPOINT_CONFIG__=${config};</script>`;
}

function insertBefore(html: string, marker: RegExp, snippet: string, fallbackPrepend: boolean): string {
  const match = marker.exec(html);
  if (match) {
    const at = match.index;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  return fallbackPrepend ? snippet + html : html + snippet;
}

/**
 * For already-instrumented static HTML (overlay css/js links present): inject
 * only the per-page config script before `</head>`.
 */
export function injectStaticConfig(html: string, ctx: OverlayContext): string {
  return insertBefore(html, /<\/head>/i, `${overlayConfigScript(ctx)}\n`, true);
}

/**
 * For proxied framework HTML (no overlay references yet): inject the overlay
 * css + config before `</head>` and the overlay script before `</body>`.
 */
export function injectFullOverlay(html: string, ctx: OverlayContext): string {
  const headSnippet =
    `<link rel="stylesheet" href="${OVERLAY_URLS.css}" data-pinpoint-ui="1" />\n` +
    `${overlayConfigScript(ctx)}\n`;
  const bodySnippet = `<script src="${OVERLAY_URLS.js}" data-pinpoint-ui="1" defer></script>\n`;
  let out = insertBefore(html, /<\/head>/i, headSnippet, true);
  out = insertBefore(out, /<\/body>/i, bodySnippet, false);
  return out;
}
