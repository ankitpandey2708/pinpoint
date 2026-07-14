import { createHash, randomUUID } from 'node:crypto';

/**
 * Generate a prefixed, globally-unique entity id (e.g. `rev_<uuid>`).
 * Used for projects, reviews, annotations, and jobs.
 */
export function entityId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Deterministic identifier for a source location. The same normalized
 * (file, line, column, tag) always produces the same id, so instrumented
 * elements can be re-mapped to source across runs. Path separators are
 * normalized so Windows and POSIX paths agree.
 */
export function sourceId(
  relativeFile: string,
  line: number,
  column: number,
  tag: string,
): string {
  const normalizedFile = relativeFile.replace(/\\/g, '/');
  const key = `${normalizedFile}::${line}::${column}::${tag.toLowerCase()}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}
