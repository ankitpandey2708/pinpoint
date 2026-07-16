import { OVERLAY_URLS, PINPOINT_BASE } from '../preview/constants';

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
    apiBase: `${PINPOINT_BASE}/api`,
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
 * Preserve Astro's dev-mode source attributes for click-to-source resolution.
 *
 * `astro dev` stamps every element with `data-astro-source-file` / `-loc`, but
 * Astro's dev-toolbar audit app removes them from the DOM on load (moving them
 * into a private WeakMap), so the overlay's client-side resolver would find none
 * at click time. We copy each into a Pinpoint-namespaced twin the audit app does
 * not touch — it only queries and strips its own `data-astro-source-*`. The twin
 * therefore survives, and `astroSourceFrom` (overlay/resolve.ts) reads it. The
 * originals are left intact so Astro's own tooling is unaffected. A no-op on
 * non-Astro pages (no matching attributes) and on prod builds (no tags emitted).
 */
function preserveAstroSource(html: string): string {
  if (!html.includes('data-astro-source-file')) return html;
  return html
    .replace(
      /data-astro-source-file=(["'])(.*?)\1/g,
      (match, quote, value) => `data-pinpoint-src-file=${quote}${value}${quote} ${match}`,
    )
    .replace(
      /data-astro-source-loc=(["'])(.*?)\1/g,
      (match, quote, value) => `data-pinpoint-src-loc=${quote}${value}${quote} ${match}`,
    );
}

/**
 * Inject the overlay into a preview page (framework proxy or static serve): the
 * overlay css + per-page config before `</head>` and the overlay bundle before
 * `</body>`.
 */
export function injectFullOverlay(html: string, ctx: OverlayContext): string {
  const headSnippet =
    `<link rel="stylesheet" href="${OVERLAY_URLS.css}" data-pinpoint-ui="1" />\n` +
    `${overlayConfigScript(ctx)}\n`;
  const bodySnippet = `<script src="${OVERLAY_URLS.js}" data-pinpoint-ui="1" defer></script>\n`;
  let out = preserveAstroSource(html);
  out = insertBefore(out, /<\/head>/i, headSnippet, true);
  out = insertBefore(out, /<\/body>/i, bodySnippet, false);
  return out;
}
