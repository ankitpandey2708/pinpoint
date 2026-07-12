import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the directory holding static browser assets (overlay + dashboard).
 * Works under tsx (src/server -> ../public) and under a compiled build
 * (dist/server -> ../public after assets are copied). Falls back to the source
 * tree so `npm run dev` works without a build step.
 */
export function publicDir(): string {
  const candidates = [
    join(__dirname, '..', 'public'),
    join(__dirname, '..', '..', 'src', 'public'),
    join(process.cwd(), 'src', 'public'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'overlay.js'))) return dir;
  }
  return candidates[0];
}
