import { describe, it, expect } from 'vitest';
import { entityId, sourceId } from '../../src/lib/ids';

describe('entityId', () => {
  it('prefixes the id and separates with an underscore', () => {
    const id = entityId('rev');
    expect(id.startsWith('rev_')).toBe(true);
    expect(id.length).toBeGreaterThan('rev_'.length);
  });

  it('produces unique ids across calls', () => {
    const a = entityId('job');
    const b = entityId('job');
    expect(a).not.toBe(b);
  });
});

describe('sourceId', () => {
  it('is deterministic for the same source location', () => {
    const a = sourceId('src/Hero.tsx', 12, 4, 'h1');
    const b = sourceId('src/Hero.tsx', 12, 4, 'h1');
    expect(a).toBe(b);
  });

  it('normalizes windows and posix path separators to the same id', () => {
    const posix = sourceId('src/components/Hero.tsx', 12, 4, 'h1');
    const windows = sourceId('src\\components\\Hero.tsx', 12, 4, 'h1');
    expect(posix).toBe(windows);
  });

  it('differs when the line changes', () => {
    const a = sourceId('src/Hero.tsx', 12, 4, 'h1');
    const b = sourceId('src/Hero.tsx', 13, 4, 'h1');
    expect(a).not.toBe(b);
  });

  it('differs when the column changes', () => {
    const a = sourceId('src/Hero.tsx', 12, 4, 'h1');
    const b = sourceId('src/Hero.tsx', 12, 5, 'h1');
    expect(a).not.toBe(b);
  });

  it('differs when the tag changes', () => {
    const a = sourceId('src/Hero.tsx', 12, 4, 'h1');
    const b = sourceId('src/Hero.tsx', 12, 4, 'h2');
    expect(a).not.toBe(b);
  });

  it('produces a stable hex string', () => {
    const id = sourceId('src/Hero.tsx', 12, 4, 'h1');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
