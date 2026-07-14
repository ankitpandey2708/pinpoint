import { randomUUID } from 'node:crypto';
import { runProcess } from '../../platform/process';

async function git(cwd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const res = await runProcess('git', args, { cwd, timeoutMs: 60_000 });
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim() };
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const res = await git(cwd, args);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.err || res.out}`);
  }
  return res.out;
}

/** A safe, unique review branch name; never collides with an existing branch. */
export function generateBranchName(seed?: string): string {
  const suffix = (seed ? seed.replace(/[^A-Za-z0-9]+/g, '').slice(-8) : '') || randomUUID().slice(0, 8);
  return `pinpoint/review-${suffix}-${randomUUID().slice(0, 6)}`;
}

/**
 * Create and check out the generated review branch from an exact base commit,
 * directly in the repository (no separate worktree). The tree must be clean
 * (Pinpoint enforces this before a review is created).
 */
export async function createReviewBranch(
  repoRoot: string,
  branch: string,
  baseCommit: string,
): Promise<void> {
  await gitOrThrow(repoRoot, ['checkout', '-b', branch, baseCommit]);
}

/** Repository-relative paths changed in the working tree (staged or unstaged). */
export async function changedFiles(repoRoot: string): Promise<string[]> {
  const res = await runProcess('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  if (res.code !== 0) {
    throw new Error(`git status failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3))
    .map((p) => {
      // Handle rename "old -> new" by taking the destination.
      const arrow = p.indexOf(' -> ');
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    })
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Stage and commit all changes on the current branch. Returns `committed: false`
 * without creating a commit when nothing changed (no-change refusal).
 */
export async function commitAll(
  repoRoot: string,
  message: string,
): Promise<{ committed: boolean; sha?: string }> {
  const files = await changedFiles(repoRoot);
  if (files.length === 0) return { committed: false };

  await gitOrThrow(repoRoot, ['add', '-A']);
  await gitOrThrow(repoRoot, [
    '-c',
    'user.email=pinpoint@localhost',
    '-c',
    'user.name=Pinpoint',
    'commit',
    '-m',
    message,
  ]);
  const sha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
  return { committed: true, sha };
}

/**
 * Return the working tree to a branch, discarding any uncommitted changes made
 * during the job. Used in a finally so the developer's checkout is never left on
 * the generated branch or dirty. The generated branch (and its commit) remain.
 */
export async function restoreBranch(repoRoot: string, branch: string): Promise<void> {
  await gitOrThrow(repoRoot, ['checkout', '-f', branch]);
}

/**
 * Discard all tracked changes in the working tree back to HEAD. On the review
 * branch (created from the base commit, before any commit) this yields a clean
 * baseline tree. The agent has no shell access, so its edits are all tracked and
 * fully reverted by this.
 */
export async function resetHard(repoRoot: string): Promise<void> {
  await gitOrThrow(repoRoot, ['reset', '--hard']);
}
