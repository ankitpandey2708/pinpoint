import { parse } from 'parse5';
import MagicString from 'magic-string';
import { sourceId } from '../lib/ids';
import type { SourceMapping } from '../domain/types';
import type { InstrumentationResult, OverlayUrls } from './types';

// Structural / non-visible tags that never receive a pinpoint id.
const EXCLUDED = new Set([
  'html',
  'head',
  'body',
  'meta',
  'title',
  'script',
  'style',
  'link',
  'base',
  'noscript',
  'br',
  'hr',
  'wbr',
]);

interface P5Location {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
}

interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  sourceCodeLocation?: P5Location | null;
}

function findByTag(root: P5Node, tag: string): P5Node | undefined {
  if (root.tagName === tag) return root;
  for (const child of root.childNodes ?? []) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return undefined;
}

function hasPinpointUi(node: P5Node): boolean {
  return (node.attrs ?? []).some((a) => a.name === 'data-pinpoint-ui');
}

/**
 * Instrument a static HTML document: assign a stable `data-pinpoint-id` to each
 * visible body element and inject exactly one overlay CSS reference before
 * `</head>` and one overlay script before `</body>`. The original text is
 * preserved via MagicString byte-level edits; nothing is reserialized.
 */
export function instrumentHtml(
  html: string,
  relativeFile: string,
  overlayUrls: OverlayUrls,
): InstrumentationResult {
  const doc = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const s = new MagicString(html);
  const mappings: SourceMapping[] = [];

  const body = findByTag(doc, 'body');
  const head = findByTag(doc, 'head');

  const instrument = (node: P5Node): void => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName) {
        const tag = child.tagName.toLowerCase();
        const loc = child.sourceCodeLocation;
        if (
          !EXCLUDED.has(tag) &&
          !hasPinpointUi(child) &&
          loc?.startTag &&
          typeof loc.startLine === 'number'
        ) {
          const id = sourceId(relativeFile, loc.startLine, loc.startCol, tag);
          const insertAt = loc.startTag.startOffset + 1 + tag.length;
          s.appendLeft(insertAt, ` data-pinpoint-id="${id}"`);
          mappings.push({
            elementId: id,
            sourceFile: relativeFile,
            line: loc.startLine,
            column: loc.startCol,
            tag,
            confidence: 'direct',
          });
        }
      }
      instrument(child);
    }
  };

  if (body) instrument(body);

  const cssTag = `\n    <link rel="stylesheet" href="${overlayUrls.css}" data-pinpoint-ui="1" />\n  `;
  const jsTag = `\n    <script src="${overlayUrls.js}" data-pinpoint-ui="1" defer></script>\n  `;

  const headClose = head?.sourceCodeLocation?.endTag?.startOffset;
  if (typeof headClose === 'number') {
    s.appendLeft(headClose, cssTag);
  } else {
    s.prepend(cssTag);
  }

  const bodyClose = body?.sourceCodeLocation?.endTag?.startOffset;
  if (typeof bodyClose === 'number') {
    s.appendLeft(bodyClose, jsTag);
  } else {
    s.append(jsTag);
  }

  return { content: s.toString(), mappings };
}
