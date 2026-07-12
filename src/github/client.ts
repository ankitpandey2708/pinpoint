import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../lib/process';

export interface DraftPrInput {
  /** Directory to run git/gh from (the worktree, which has the branch checked out). */
  cwd: string;
  /** The generated branch to push and open a PR from. */
  branch: string;
  /** The base branch the PR targets. */
  baseBranch: string;
  /** PR title. */
  title: string;
  /** PR body (markdown). Written to a temp file and passed via --body-file. */
  body: string;
  remote?: string;
  /** owner/repo; passed to gh via --repo when present. */
  repo?: string;
  /** Injectable base command for git (default ['git']). */
  git?: string[];
  /** Injectable base command for gh (default ['gh']). */
  gh?: string[];
  env?: NodeJS.ProcessEnv;
}

async function run(base: string[], args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return runProcess(base[0], [...base.slice(1), ...args], { cwd, env, timeoutMs: 120_000 });
}

/** Extract `{ url, number }` from gh's output (the PR URL). */
function parsePrUrl(output: string): { url: string; number: number } | undefined {
  const match = /(https:\/\/github\.com\/[^\s]+\/pull\/(\d+))/.exec(output);
  if (!match) return undefined;
  return { url: match[1], number: Number(match[2]) };
}

/**
 * Push the generated branch and open a DRAFT pull request through the
 * authenticated `gh` CLI. Never force-pushes and never merges. Failures from
 * git or gh are propagated so the orchestrator marks the job failed.
 */
export async function createDraftPullRequest(input: DraftPrInput): Promise<{ url: string; number: number }> {
  const gitBase = input.git ?? ['git'];
  const ghBase = input.gh ?? ['gh'];
  const remote = input.remote ?? 'origin';

  // 1. Push the branch (upstream tracking, never force).
  const push = await run(gitBase, ['push', '-u', remote, input.branch], input.cwd, input.env);
  if (push.code !== 0) {
    throw new Error(`git push failed: ${push.stderr || push.stdout}`);
  }

  // 2. Write the PR body to a temp file.
  const dir = await mkdtemp(join(tmpdir(), 'pinpoint-pr-'));
  const bodyFile = join(dir, 'pr-body.md');
  await writeFile(bodyFile, input.body, 'utf8');

  try {
    const ghArgs = [
      'pr',
      'create',
      '--draft',
      '--base',
      input.baseBranch,
      '--head',
      input.branch,
      '--title',
      input.title,
      '--body-file',
      bodyFile,
    ];
    if (input.repo) ghArgs.push('--repo', input.repo);

    const gh = await run(ghBase, ghArgs, input.cwd, input.env);
    if (gh.code !== 0) {
      throw new Error(`gh pr create failed: ${gh.stderr || gh.stdout}`);
    }
    const parsed = parsePrUrl(gh.stdout + '\n' + gh.stderr);
    if (!parsed) {
      throw new Error(`could not parse pull request URL from gh output: ${gh.stdout}`);
    }
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
