import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/lib/process';
import {
  createWorktree,
  changedFiles,
  commitAll,
  removeWorktree,
  generateBranchName,
} from '../../src/git/worktree';

let tmp: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runProcess('git', args, { cwd, timeoutMs: 15_000 });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function head(cwd: string): Promise<string> {
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pinpoint-wt-'));
  repo = join(tmp, 'repo');
  await mkdtemp(join(tmpdir(), 'x')); // noop to keep os import warm
  await git(tmp, 'init', '-b', 'main', 'repo');
  await writeFile(join(repo, 'index.html'), '<h1>Hi</h1>\n');
  await git(repo, 'add', '-A');
  await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('git worktree lifecycle', () => {
  it('generates a review branch name', () => {
    expect(generateBranchName('rev_abc123')).toMatch(/^pinpoint\/review-/);
  });

  it('creates a worktree at the exact base commit on a new branch', async () => {
    const base = await head(repo);
    const wtPath = join(tmp, 'wt');
    const branch = generateBranchName('rev_abc');
    const wt = await createWorktree({ repoRoot: repo, baseCommit: base, branch, path: wtPath });
    expect(wt.branch).toBe(branch);
    expect(wt.path).toBe(wtPath);
    expect(await head(wtPath)).toBe(base);
    expect(await git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
  });

  it('refuses to reuse an existing branch or path', async () => {
    const base = await head(repo);
    const branch = generateBranchName('rev_dup');
    await createWorktree({ repoRoot: repo, baseCommit: base, branch, path: join(tmp, 'a') });
    await expect(
      createWorktree({ repoRoot: repo, baseCommit: base, branch, path: join(tmp, 'b') }),
    ).rejects.toThrow();
  });

  it('isolates edits from the original working tree', async () => {
    const base = await head(repo);
    const wtPath = join(tmp, 'wt');
    await createWorktree({ repoRoot: repo, baseCommit: base, branch: generateBranchName('r'), path: wtPath });
    await writeFile(join(wtPath, 'index.html'), '<h1>Changed</h1>\n');
    // The original repo working tree is untouched.
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('detects changed files and commits them, refusing when nothing changed', async () => {
    const base = await head(repo);
    const wtPath = join(tmp, 'wt');
    await createWorktree({ repoRoot: repo, baseCommit: base, branch: generateBranchName('r'), path: wtPath });

    // Nothing changed yet: commit is refused.
    const none = await commitAll(wtPath, 'no-op');
    expect(none.committed).toBe(false);

    await writeFile(join(wtPath, 'index.html'), '<h1>Bigger</h1>\n');
    const files = await changedFiles(wtPath);
    expect(files).toContain('index.html');

    const committed = await commitAll(wtPath, 'apply feedback');
    expect(committed.committed).toBe(true);
    expect(committed.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await changedFiles(wtPath)).toEqual([]);
    expect(await head(wtPath)).not.toBe(base);
  });

  it('removes a worktree on cleanup', async () => {
    const base = await head(repo);
    const wtPath = join(tmp, 'wt');
    await createWorktree({ repoRoot: repo, baseCommit: base, branch: generateBranchName('r'), path: wtPath });
    expect(existsSync(wtPath)).toBe(true);
    await removeWorktree(repo, wtPath);
    expect(existsSync(wtPath)).toBe(false);
  });
});
