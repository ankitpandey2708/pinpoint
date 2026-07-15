import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, redactSecrets } from '../platform/process';

/** GitHub host used for credential lookups and the REST API base. */
const GITHUB_HOST = 'github.com';
const GITHUB_API = 'https://api.github.com';

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
  env?: NodeJS.ProcessEnv;
}

async function run(base: string[], args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return runProcess(base[0], [...base.slice(1), ...args], { cwd, env, timeoutMs: 120_000 });
}

/** True when the GitHub CLI is installed and authenticated. */
export async function ghAuthenticated(): Promise<boolean> {
  const res = await runProcess('gh', ['auth', 'status'], { timeoutMs: 15_000 });
  return res.code === 0;
}

/**
 * Ask git for the HTTPS credential it would use to push to `host`, via
 * `git credential fill`. Returns the token that the OS credential helper
 * (Git Credential Manager on Windows, Keychain on macOS, libsecret on Linux)
 * hands back as the `password`, or undefined when none is available (e.g.
 * SSH-only setups — SSH keys can't authenticate the REST API anyway).
 *
 * Runs non-interactively (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`) with
 * a timeout so a missing credential can never pop a prompt or hang the server.
 * Uses `raw` so redaction does not scrub the `password=` line we must read; the
 * result is consumed immediately and never logged.
 */
export async function gitCredentialToken(
  cwd?: string,
  host: string = GITHUB_HOST,
): Promise<string | undefined> {
  const res = await runProcess('git', ['credential', 'fill'], {
    cwd,
    input: `protocol=https\nhost=${host}\n\n`,
    timeoutMs: 15_000,
    raw: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (res.code !== 0) return undefined;
  const token = /^password=(.*)$/m.exec(res.stdout)?.[1]?.trim();
  return token || undefined;
}

/**
 * Preflight: confirm we can ultimately open a draft PR, so the step won't
 * surprise-fail after an agent has already run. Passes when the GitHub CLI is
 * authenticated OR git has a usable HTTPS credential for github.com. Runs from
 * `cwd` so repo-scoped credential config is respected.
 */
export async function checkGitHubAuth(cwd?: string): Promise<void> {
  if (await ghAuthenticated()) return;
  if (await gitCredentialToken(cwd)) return;
  throw new Error(
    'No GitHub authentication available. Either run `gh auth login`, or make sure ' +
      '`git push` to github.com works over HTTPS (a stored Git credential) before starting a review.',
  );
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
  const gitBase = ['git'];
  const ghBase = ['gh'];
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

/**
 * Push the branch and open a DRAFT pull request through the GitHub REST API,
 * using a token obtained outside the `gh` CLI (from `git credential fill`). The
 * token is sent only to api.github.com over HTTPS and is never logged; API error
 * bodies are redacted defensively before surfacing. Never force-pushes.
 */
export async function createDraftPullRequestViaApi(
  input: DraftPrInput,
  token: string,
): Promise<{ url: string; number: number }> {
  const gitBase = ['git'];
  const remote = input.remote ?? 'origin';
  if (!input.repo) {
    throw new Error('cannot open a pull request via the API without an owner/repo');
  }

  // 1. Push the branch (git's own credentials, upstream tracking, never force).
  const push = await run(gitBase, ['push', '-u', remote, input.branch], input.cwd, input.env);
  if (push.code !== 0) {
    throw new Error(`git push failed: ${push.stderr || push.stdout}`);
  }

  // 2. Create the draft PR.
  const res = await fetch(`${GITHUB_API}/repos/${input.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pinpoint',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      head: input.branch,
      base: input.baseBranch,
      body: input.body,
      draft: true,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `GitHub API pull request creation failed (${res.status}): ${redactSecrets(detail)}`,
    );
  }
  const data = (await res.json()) as { html_url?: string; number?: number };
  if (!data.html_url || typeof data.number !== 'number') {
    throw new Error('GitHub API returned an unexpected pull request response');
  }
  return { url: data.html_url, number: data.number };
}

/**
 * Open a draft PR by the best available auth path: the `gh` CLI when it is
 * authenticated, otherwise a token from git's HTTPS credential helper via the
 * REST API. Throws (mirroring the preflight message) when neither is available.
 */
export async function openDraftPullRequest(
  input: DraftPrInput,
): Promise<{ url: string; number: number }> {
  if (await ghAuthenticated()) {
    return createDraftPullRequest(input);
  }
  const token = await gitCredentialToken(input.cwd);
  if (token) {
    return createDraftPullRequestViaApi(input, token);
  }
  throw new Error(
    'No GitHub authentication available. Either run `gh auth login`, or make sure ' +
      '`git push` to github.com works over HTTPS (a stored Git credential).',
  );
}
