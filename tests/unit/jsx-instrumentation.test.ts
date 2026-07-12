import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentJsx } from '../../src/instrumentation/jsx';

const hero = readFileSync(join(__dirname, '../fixtures/react-site/src/Hero.tsx'), 'utf8');
const cardList = readFileSync(join(__dirname, '../fixtures/react-site/src/CardList.tsx'), 'utf8');

describe('instrumentJsx', () => {
  it('adds data-pinpoint-id to lowercase host elements', () => {
    const { content, mappings } = instrumentJsx(hero, 'src/Hero.tsx');
    expect(content).toMatch(/<section[^>]*data-pinpoint-id="[0-9a-f]{16}"/);
    expect(content).toMatch(/<h1[^>]*data-pinpoint-id="[0-9a-f]{16}"/);
    expect(mappings.map((m) => m.tag).sort()).toEqual(['h1', 'p', 'section', 'span']);
  });

  it('does not instrument custom components or fragments', () => {
    const { content } = instrumentJsx(hero, 'src/Hero.tsx');
    expect(content).not.toMatch(/<CustomButton[^>]*data-pinpoint-id/);
    // The fragment open tag `<>` is never given attributes.
    expect(content).toContain('<>');
  });

  it('parses TypeScript syntax and preserves existing spread props', () => {
    const { content } = instrumentJsx(cardList, 'src/CardList.tsx');
    expect(content).toMatch(/<ul[^>]*data-pinpoint-id="[0-9a-f]{16}"/);
    expect(content).toContain('{...rest}');
    expect(content).toContain('className="cards"');
  });

  it('instruments elements created inside .map() exactly once', () => {
    const { content, mappings } = instrumentJsx(cardList, 'src/CardList.tsx');
    const liIds = content.match(/<li[^>]*data-pinpoint-id/g) ?? [];
    expect(liIds).toHaveLength(1);
    expect(mappings.filter((m) => m.tag === 'li')).toHaveLength(1);
  });

  it('derives the nearest component name', () => {
    const heroMappings = instrumentJsx(hero, 'src/Hero.tsx').mappings;
    expect(heroMappings.every((m) => m.component === 'Hero')).toBe(true);
    const cardMappings = instrumentJsx(cardList, 'src/CardList.tsx').mappings;
    expect(cardMappings.every((m) => m.component === 'CardList')).toBe(true);
  });

  it('produces deterministic ids and direct confidence', () => {
    const a = instrumentJsx(hero, 'src/Hero.tsx');
    const b = instrumentJsx(hero, 'src/Hero.tsx');
    expect(a.mappings.map((m) => m.elementId)).toEqual(b.mappings.map((m) => m.elementId));
    expect(a.mappings.every((m) => m.confidence === 'direct')).toBe(true);
    expect(a.mappings.every((m) => m.sourceFile === 'src/Hero.tsx')).toBe(true);
  });
});
