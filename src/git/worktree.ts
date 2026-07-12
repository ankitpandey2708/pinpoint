import { randomUUID } from 'node:crypto';
import { runProcess } from '../lib/process';

export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface CreateWorktreeInput {
  /** The main repository root the worktree is attached to. */
  repoRoot: string;
  /** The exact commit the worktree (and new branch) starts from. */
  baseCommit: string;
  /** The generated branch name to create. Must not already exist. */
  branch: string;
  /** Absolute path for the new worktree. Must not already exist. */
  path: string;
}

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
 * Create an isolated worktree on a new branch based on an exact commit. Refuses
 * to reuse an existing branch or path (git itself errors, which we surface).
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
  await gitOrThrow(input.repoRoot, [
    'worktree',
    'add',
    '-b',
    input.branch,
    input.path,
    input.baseCommit,
  ]);
  return { path: input.path, branch: input.branch, baseCommit: input.baseCommit };
}

/** Repository-relative paths changed inside a worktree (staged or unstaged). */
export async function changedFiles(worktreePath: string): Promise<string[]> {
  const out = await gitOrThrow(worktreePath, ['status', '--porcelain']);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .map((p) => {
      // Handle rename "old -> new" by taking the destination.
      const arrow = p.indexOf(' -> ');
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    })
    .filter(Boolean);
}

/**
 * Stage and commit all changes in the worktree. Returns `committed: false`
 * without creating a commit when nothing changed (no-change refusal), so the
 * orchestrator can skip pushing/PR creation.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
): Promise<{ committed: boolean; sha?: string }> {
  const files = await changedFiles(worktreePath);
  if (files.length === 0) return { committed: false };

  await gitOrThrow(worktreePath, ['add', '-A']);
  await gitOrThrow(worktreePath, [
    '-c',
    'user.email=pinpoint@localhost',
    '-c',
    'user.name=Pinpoint',
    'commit',
    '-m',
    message,
  ]);
  const sha = await gitOrThrow(worktreePath, ['rev-parse', 'HEAD']);
  return { committed: true, sha };
}

/** Remove a worktree and prune its metadata. Used only after success. */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await gitOrThrow(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  await git(repoRoot, ['worktree', 'prune']);
}
