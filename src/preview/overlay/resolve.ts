/*
 * Client-side source resolver for the review overlay.
 *
 * Replaces build-time `data-pinpoint-id` instrumentation: at click time we ask
 * `element-source` (items 1-5 of the reuse plan) to map the clicked DOM node to
 * its framework source, then assemble the react-grab-style enriched payload
 * (item 6) — component + stack + rendered snippet + text + selector — which is
 * precise enough for the fix agent even when source resolution is only
 * component-level.
 *
 * This module is bundled into the browser overlay by scripts/build-overlay.mjs;
 * it must stay browser-safe (no Node APIs).
 */
import { resolveElementInfo } from 'element-source';

/** One source frame as reported by element-source, normalized to our shape. */
export interface ResolvedSource {
  filePath: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
}

/** The enriched locator payload sent to the server for one selected element. */
export interface EnrichedTarget {
  tag: string;
  componentName: string | null;
  /** Nearest resolved source frame (the primary edit target). */
  source: ResolvedSource | null;
  /** Full component stack, nearest-first (react-grab-style hierarchy). */
  stack: ResolvedSource[];
  /** Trimmed visible text of the element. */
  visibleText: string;
  /** Trimmed text of the parent, for extra grounding. */
  nearbyText: string;
  /** Best-effort unique CSS selector, so markers can re-find the element. */
  selector: string;
  /** Trimmed opening-tag snippet of what was clicked (agent grounding). */
  outerHtml: string;
  classes: string[];
}

const MAX_TEXT = 200;
const MAX_HTML = 400;

/** Best-effort unique-ish CSS selector (ported from the legacy overlay). */
export function cssSelector(el: Element): string {
  if (!el || el.nodeType !== 1) return '';
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'body' && depth < 6) {
    let tag = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(tag + '#' + node.id);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.prototype.filter.call(
        parent.children,
        (c: Element) => c.tagName === (node as Element).tagName,
      ) as Element[];
      if (sameTag.length > 1) {
        tag += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
    }
    parts.unshift(tag);
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

/**
 * Astro fallback. Astro components (`.astro`) render to static HTML with no
 * client-side framework runtime, so `element-source` (which reads framework
 * fibers) resolves nothing. In dev, though, `astro dev` stamps every rendered
 * element with `data-astro-source-file` (absolute path) and `data-astro-source-loc`
 * (`"line:col"`).
 *
 * We cannot read those attributes directly: Astro's dev-toolbar audit app runs
 * on load and `removeAttribute`s every `data-astro-source-*` (moving them into an
 * internal WeakMap), so by the time a reviewer clicks, the live DOM carries none
 * of them. Instead, the preview proxy copies each attribute into a
 * Pinpoint-namespaced twin (`data-pinpoint-src-file` / `-loc`) before serving the
 * HTML — Astro's audit only queries/strips its own `data-astro-source-*`, so our
 * twins survive. We walk up from the clicked node to the nearest twinned ancestor
 * and synthesize a source frame from it. The server anchors the absolute path to a
 * tracked repo file (toTrackedPath), so `direct` mapping — and the fix agent — work
 * on Astro sites too. Only present under `astro dev`; a prod build has no tags.
 */
function astroSourceFrom(el: Element): ResolvedSource | null {
  const tagged =
    typeof el.closest === 'function' ? el.closest('[data-pinpoint-src-file]') : null;
  if (!tagged) return null;
  const filePath = tagged.getAttribute('data-pinpoint-src-file');
  if (!filePath) return null;
  const loc = tagged.getAttribute('data-pinpoint-src-loc') || '';
  const [lineRaw, colRaw] = loc.split(':');
  const line = Number.parseInt(lineRaw, 10);
  const col = Number.parseInt(colRaw, 10);
  return {
    filePath,
    lineNumber: Number.isFinite(line) ? line : null,
    columnNumber: Number.isFinite(col) ? col : null,
    componentName: null,
  };
}

function normalizeFrame(frame: unknown): ResolvedSource | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  const filePath = typeof f.filePath === 'string' ? f.filePath : null;
  if (!filePath) return null;
  return {
    filePath,
    lineNumber: typeof f.lineNumber === 'number' ? f.lineNumber : null,
    columnNumber: typeof f.columnNumber === 'number' ? f.columnNumber : null,
    componentName: typeof f.componentName === 'string' ? f.componentName : null,
  };
}

/** Trimmed opening tag of the element (no children), for agent grounding. */
function openingTag(el: Element): string {
  const html = el.outerHTML || '';
  const gt = html.indexOf('>');
  const open = gt === -1 ? html : html.slice(0, gt + 1);
  return open.slice(0, MAX_HTML);
}

/**
 * Resolve a clicked element into the enriched locator payload. Source resolution
 * is best-effort: if element-source cannot resolve (non-framework element,
 * production build), source/stack are null/empty but the DOM-derived fields
 * (text, selector, snippet) still give the agent something to work with.
 */
export async function resolveTarget(el: Element): Promise<EnrichedTarget> {
  let info: Record<string, unknown> | null = null;
  try {
    info = (await resolveElementInfo(el)) as unknown as Record<string, unknown>;
  } catch {
    info = null;
  }

  const rawStack = Array.isArray(info?.stack) ? (info!.stack as unknown[]) : [];
  const stack = rawStack.map(normalizeFrame).filter((s): s is ResolvedSource => s !== null);
  // Framework fibers first (React/Vue/Svelte/…); fall back to Astro's dev-mode
  // source attributes when element-source resolved nothing (Astro static HTML).
  const source = normalizeFrame(info?.source) ?? stack[0] ?? astroSourceFrom(el) ?? null;
  if (stack.length === 0 && source) stack.push(source);

  const parentText = el.parentElement ? el.parentElement.textContent || '' : '';
  return {
    tag: el.tagName.toLowerCase(),
    componentName:
      (typeof info?.componentName === 'string' ? (info!.componentName as string) : null) ??
      source?.componentName ??
      null,
    source,
    stack,
    visibleText: (el.textContent || '').trim().slice(0, MAX_TEXT),
    nearbyText: parentText.trim().slice(0, MAX_TEXT),
    selector: cssSelector(el),
    outerHtml: openingTag(el),
    classes: el.classList ? Array.prototype.slice.call(el.classList) : [],
  };
}
