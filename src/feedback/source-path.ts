/*
 * Server-side normalization + validation of client-reported source paths
 * (reuse item 9). With source resolution moved client-side (element-source),
 * the browser sends a file path — which is untrusted and arrives in mixed forms:
 *
 *   components\DistrictPage.tsx                                  (relative, win)
 *   /Users/akp/Downloads/dhbvn-web/components/MobileStatusBar.tsx (source-map abs)
 *
 * We anchor every path to the repository by matching it against the set of
 * git-tracked files (react-grab's "run at project root" idea). A path that does
 * not resolve to a tracked file is rejected — this is both the correctness fix
 * and the security boundary against an external reviewer injecting an arbitrary
 * path.
 */
import { runProcess } from '../platform/process';

/** Load the set of git-tracked files (repo-relative, forward slashes). */
export async function loadTrackedFiles(repoRoot: string): Promise<Set<string>> {
  const res = await runProcess('git', ['-C', repoRoot, 'ls-files'], { timeoutMs: 30_000 });
  const set = new Set<string>();
  if (res.code === 0) {
    for (const line of res.stdout.split('\n')) {
      const t = line.trim();
      if (t) set.add(t);
    }
  }
  return set;
}

/**
 * Resolve an untrusted client path to a repo-relative tracked file, or null if
 * it matches none. Normalizes separators and strips any drive/absolute prefix,
 * then takes the longest tracked file that is a path-suffix of it (so an
 * absolute source-map path collapses onto its tracked tail, while a short file
 * name cannot spuriously shadow a longer real path).
 */
export function toTrackedPath(rawPath: string | null | undefined, tracked: Set<string>): string | null {
  if (!rawPath) return null;
  const norm = rawPath
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '');
  if (!norm) return null;
  if (tracked.has(norm)) return norm;
  let best: string | null = null;
  for (const t of tracked) {
    if (norm === t || norm.endsWith('/' + t)) {
      if (best === null || t.length > best.length) best = t;
    }
  }
  return best;
}
