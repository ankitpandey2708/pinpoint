import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const PROTECTED_PATHS = [
  /^\.git(?:\/|$)/i,
  /^\.github\/workflows(?:\/|$)/i,
  /^\.(?:husky|githooks)(?:\/|$)/i,
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock)$/i,
  /^\.(?:npmrc|yarnrc|pnpmrc|netrc)$/i,
  /^\.env(?:\..*)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

function normalizedRelative(worktreeRoot: string, file: string): string {
  if (!file || file.includes('\0') || isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
    throw new Error(`unsafe changed path outside worktree: ${file}`);
  }
  const root = resolve(worktreeRoot);
  const absolute = resolve(root, file);
  const rel = relative(root, absolute).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`unsafe changed path outside worktree: ${file}`);
  }
  return rel;
}

/**
 * Fail closed before verification/commit when an agent touches execution,
 * credential, dependency, or Git-control files. Symlink edits are rejected
 * because their target may escape the isolated worktree.
 */
export async function assertSafeChangedFiles(worktreeRoot: string, files: string[]): Promise<void> {
  for (const file of files) {
    const rel = normalizedRelative(worktreeRoot, file);
    if (PROTECTED_PATHS.some((pattern) => pattern.test(rel))) {
      throw new Error(`agent changed protected file: ${rel}`);
    }
    try {
      const info = await lstat(resolve(worktreeRoot, rel));
      if (info.isSymbolicLink()) {
        throw new Error(`agent changed symbolic link: ${rel}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Deleted files no longer exist; the normalized/protected path checks still apply.
      if (code !== 'ENOENT') throw error;
    }
  }
}
