import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentHtml } from '../../src/instrumentation/html';

const html = readFileSync(join(__dirname, '../fixtures/static-site/index.html'), 'utf8');
const overlayUrls = { css: '/__pinpoint__/overlay.css', js: '/__pinpoint__/overlay.js' };

describe('instrumentHtml', () => {
  it('adds data-pinpoint-id to visible body elements', () => {
    const { content } = instrumentHtml(html, 'index.html', overlayUrls);
    expect(content).toMatch(/<h1[^>]*data-pinpoint-id="[0-9a-f]{16}"/);
    expect(content).toMatch(/<button[^>]*data-pinpoint-id="[0-9a-f]{16}"/);
  });

  it('produces mappings with source file and line numbers and direct confidence', () => {
    const { mappings } = instrumentHtml(html, 'index.html', overlayUrls);
    const h1 = mappings.find((m) => m.tag === 'h1');
    expect(h1).toBeTruthy();
    expect(h1?.sourceFile).toBe('index.html');
    expect(h1?.line).toBeGreaterThan(0);
    expect(h1?.confidence).toBe('direct');
    const button = mappings.find((m) => m.tag === 'button');
    expect(button).toBeTruthy();
  });

  it('does not instrument excluded tags (head, meta, title, script, style, link)', () => {
    const { content } = instrumentHtml(html, 'index.html', overlayUrls);
    expect(content).not.toMatch(/<meta\b[^>]*data-pinpoint-id/);
    expect(content).not.toMatch(/<title\b[^>]*data-pinpoint-id/);
    expect(content).not.toMatch(/<script\b[^>]*data-pinpoint-id/);
    expect(content).not.toMatch(/<link\b[^>]*data-pinpoint-id/);
    expect(content).not.toMatch(/<html\b[^>]*data-pinpoint-id/);
    expect(content).not.toMatch(/<head\b[^>]*data-pinpoint-id/);
    expect(content).not.toMatch(/<body\b[^>]*data-pinpoint-id/);
  });

  it('preserves existing attributes and text content', () => {
    const { content } = instrumentHtml(html, 'index.html', overlayUrls);
    expect(content).toContain('id="brand"');
    expect(content).toContain('class="cta"');
    expect(content).toContain('data-role="hero"');
    expect(content).toContain('Make feedback effortless');
    expect(content).toContain('Get Started');
  });

  it('produces stable ids across runs', () => {
    const a = instrumentHtml(html, 'index.html', overlayUrls);
    const b = instrumentHtml(html, 'index.html', overlayUrls);
    expect(a.mappings.map((m) => m.elementId)).toEqual(b.mappings.map((m) => m.elementId));
  });

  it('injects exactly one overlay css before </head> and one script before </body>', () => {
    const { content } = instrumentHtml(html, 'index.html', overlayUrls);
    const cssRefs = content.match(/\/__pinpoint__\/overlay\.css/g) ?? [];
    const jsRefs = content.match(/\/__pinpoint__\/overlay\.js/g) ?? [];
    expect(cssRefs).toHaveLength(1);
    expect(jsRefs).toHaveLength(1);
    const headClose = content.indexOf('</head>');
    const bodyClose = content.indexOf('</body>');
    expect(content.indexOf('overlay.css')).toBeLessThan(headClose);
    expect(content.indexOf('overlay.js')).toBeLessThan(bodyClose);
    // Injected nodes are marked so the picker ignores itself.
    expect(content).toMatch(/data-pinpoint-ui[^>]*overlay\.css|overlay\.css[^>]*data-pinpoint-ui/);
  });
});
