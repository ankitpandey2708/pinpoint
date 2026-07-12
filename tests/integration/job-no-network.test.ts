import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../src/lib/process';
import { Orchestrator, realRepoAdapter, realVerifyAdapter } from '../../src/jobs/orchestrator';
import { createRepositories, type Repositories } from '../../src/storage/repositories';
import type { CodingAgent } from '../../src/agents/types';
import type { Project, SubmittedReview } from '../../src/domain/types';

// Task 12 step 4: run a submitted review through the orchestrator end-to-end with
// REAL worktree/verify/commit but FAKE Claude and GitHub adapters, so there are no
// network side effects. Confirms the original working tree is untouched and the
// job reaches pr-opened with the fixture PR URL.
let tmp: string;
let repo: string;
let dataDir: string;
let repositories: Repositories;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runProcess('git', args, { cwd, timeoutMs: 15_000 });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pinpoint-nonet-'));
  repo = join(tmp, 'repo');
  dataDir = join(tmp, 'data');
  await git(tmp, 'init', '-b', 'main', 'repo');
  await writeFile(join(repo, 'index.html'), '<h1>Original</h1>\n');
  await git(repo, 'add', '-A');
  await git(repo, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init');

  repositories = await createRepositories(dataDir);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('orchestrated job with no network side effects', () => {
  it('applies a real change in a worktree and reaches pr-opened, leaving main untouched', async () => {
    const baseCommit = await git(repo, 'rev-parse', 'HEAD');

    const project: Project = {
      id: 'proj_1',
      name: 'repo',
      repoPath: repo,
      githubRepo: 'acme/site',
      baseBranch: 'main',
      baseCommit,
      framework: 'static',
      htmlEntry: 'index.html',
      commands: {}, // no gates → verification passes trivially, no npm needed
      host: '127.0.0.1',
      port: 3000,
      createdAt: new Date().toISOString(),
    };
    await repositories.projects.insert(project);

    const review: SubmittedReview = {
      id: 'rev_1',
      projectId: 'proj_1',
      reviewerName: 'Alice',
      githubRepo: 'acme/site',
      baseBranch: 'main',
      baseCommit,
      framework: 'static',
      route: '/',
      annotations: [
        {
          id: 'ann_1',
          index: 1,
          elementId: 'e1',
          route: '/',
          selector: 'h1',
          tag: 'h1',
          classes: [],
          visibleText: 'Original',
          nearbyText: '',
          comment: 'Make the heading say Bigger',
          mapping: { elementId: 'e1', sourceFile: 'index.html', line: 1, column: 0, tag: 'h1', confidence: 'direct' },
        },
      ],
      createdAt: new Date().toISOString(),
    };
    await repositories.reviews.insert(review);

    // Fake agent: makes a real edit inside the worktree it is given.
    const agent: CodingAgent = {
      name: 'fake-claude',
      run: async (task) => {
        await writeFile(join(task.cwd, 'index.html'), '<h1>Bigger</h1>\n');
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, events: [], log: '', durationMs: 1 };
      },
    };

    let pushed = false;
    const orch = new Orchestrator({
      repositories,
      agent,
      repo: realRepoAdapter,
      verifier: realVerifyAdapter,
      github: {
        createDraftPullRequest: async () => {
          pushed = true;
          return { url: 'https://github.com/acme/site/pull/123', number: 123 };
        },
      },
    });

    const job = await orch.startJobForReview('rev_1');
    await orch.settle(job.id);

    const final = (await repositories.jobs.get(job.id))!;
    expect(final.status).toBe('pr-opened');
    expect(final.prUrl).toBe('https://github.com/acme/site/pull/123');
    expect(final.prNumber).toBe(123);
    expect(final.changedFiles).toContain('index.html');
    expect(pushed).toBe(true);

    // The working tree is restored and clean (agent's edit is not left behind).
    // Line endings may be normalized by git's autocrlf on the in-repo checkout.
    expect(await git(repo, 'status', '--porcelain')).toBe('');
    expect((await readFile(join(repo, 'index.html'), 'utf8')).replace(/\r\n/g, '\n')).toBe(
      '<h1>Original</h1>\n',
    );
    // main still points at the base commit; the agent worked on a generated branch.
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(baseCommit);
  });
});
