import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type OrchestratorDeps } from '../../src/jobs/orchestrator';
import { createRepositories, type Repositories } from '../../src/storage/repositories';
import { entityId } from '../../src/lib/ids';
import type { CodingAgent } from '../../src/agents/types';
import type { Project, SubmittedReview, JobStatus, VerificationResult } from '../../src/domain/types';

let dataDir: string;
let repositories: Repositories;
let statuses: JobStatus[];
let pushCalls: number;
let removed: string[];

const project: Project = {
  id: 'proj_1',
  name: 'demo',
  repoPath: 'C:/demo',
  githubRepo: 'acme/site',
  remoteUrl: 'https://github.com/acme/site.git',
  baseBranch: 'main',
  baseCommit: 'c0ffeecommit',
  framework: 'static',
  htmlEntry: 'index.html',
  commands: { test: { command: 'npm', args: ['test'] } },
  host: '127.0.0.1',
  port: 3000,
  createdAt: new Date().toISOString(),
};

function makeReview(id: string): SubmittedReview {
  return {
    id,
    projectId: 'proj_1',
    reviewerName: 'Alice',
    githubRepo: 'acme/site',
    baseBranch: 'main',
    baseCommit: 'c0ffeecommit',
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
        visibleText: 'Pricing',
        nearbyText: '',
        comment: 'Make it bigger',
        mapping: { elementId: 'e1', sourceFile: 'index.html', line: 5, column: 2, tag: 'h1', confidence: 'direct' },
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

interface Knobs {
  agentOk?: boolean;
  changed?: string[];
  verifyOk?: boolean;
  githubThrows?: boolean;
}

function buildDeps(knobs: Knobs = {}): OrchestratorDeps {
  const {
    agentOk = true,
    changed = ['index.html'],
    verifyOk = true,
    githubThrows = false,
  } = knobs;

  const agent: CodingAgent = {
    name: 'fake',
    run: async () => ({
      ok: agentOk,
      exitCode: agentOk ? 0 : 1,
      timedOut: false,
      aborted: false,
      events: [],
      log: 'agent log',
      durationMs: 1,
    }),
  };

  const verification: VerificationResult = { ok: verifyOk, checks: [] };

  return {
    repositories,
    agent,
    worktrees: {
      generateBranchName: (seed) => `pinpoint/review-${seed}`,
      createWorktree: async (input) => ({ path: input.path, branch: input.branch, baseCommit: input.baseCommit }),
      changedFiles: async () => changed,
      commitAll: async () => ({ committed: changed.length > 0, sha: 'abc1234' }),
      removeWorktree: async (_root, path) => {
        removed.push(path);
      },
    },
    verifier: {
      verifyRepository: async () => verification,
    },
    github: {
      createDraftPullRequest: async () => {
        pushCalls += 1;
        if (githubThrows) throw new Error('gh failed');
        return { url: 'https://github.com/acme/site/pull/7', number: 7 };
      },
    },
    worktreesRoot: join(dataDir, 'worktrees'),
    onStatus: (job) => statuses.push(job.status),
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pinpoint-orch-'));
  repositories = await createRepositories(dataDir);
  await repositories.projects.insert(project);
  statuses = [];
  pushCalls = 0;
  removed = [];
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('Orchestrator', () => {
  it('drives a review through every stage to a draft PR', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const orch = new Orchestrator(buildDeps());
    const job = await orch.startJobForReview('rev_1');
    expect(job.status).toBe('queued');
    await orch.settle(job.id);

    const final = (await repositories.jobs.get(job.id))!;
    expect(final.status).toBe('pr-opened');
    expect(final.prUrl).toBe('https://github.com/acme/site/pull/7');
    expect(final.prNumber).toBe(7);
    expect(final.changedFiles).toEqual(['index.html']);
    expect(final.branch).toContain('pinpoint/review-');

    expect(statuses).toEqual([
      'queued',
      'preparing',
      'running-agent',
      'verifying',
      'pushing',
      'pr-opened',
    ]);
    expect(pushCalls).toBe(1);
    // Successful worktree is cleaned up.
    expect(removed).toHaveLength(1);
  });

  it('prevents more than one active job per review', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const orch = new Orchestrator(buildDeps());
    const job = await orch.startJobForReview('rev_1');
    await expect(orch.startJobForReview('rev_1')).rejects.toThrow(/active/i);
    await orch.settle(job.id);
  });

  it('allows a retry after a failed job with an incremented attempt count', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const failing = new Orchestrator(buildDeps({ agentOk: false }));
    const first = await failing.startJobForReview('rev_1');
    await failing.settle(first.id);
    expect((await repositories.jobs.get(first.id))!.status).toBe('failed');

    const ok = new Orchestrator(buildDeps());
    const retry = await ok.startJobForReview('rev_1');
    await ok.settle(retry.id);
    const retried = (await repositories.jobs.get(retry.id))!;
    expect(retried.status).toBe('pr-opened');
    expect(retried.attempts).toBe(2);
  });

  it('fails without pushing when verification fails and keeps the worktree', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const orch = new Orchestrator(buildDeps({ verifyOk: false }));
    const job = await orch.startJobForReview('rev_1');
    await orch.settle(job.id);
    const final = (await repositories.jobs.get(job.id))!;
    expect(final.status).toBe('failed');
    expect(final.verification?.ok).toBe(false);
    expect(pushCalls).toBe(0);
    expect(removed).toHaveLength(0);
    expect(statuses).not.toContain('pr-opened');
  });

  it('fails when the agent makes no changes and never verifies or pushes', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const orch = new Orchestrator(buildDeps({ changed: [] }));
    const job = await orch.startJobForReview('rev_1');
    await orch.settle(job.id);
    const final = (await repositories.jobs.get(job.id))!;
    expect(final.status).toBe('failed');
    expect(final.failureReason).toMatch(/no.*change/i);
    expect(pushCalls).toBe(0);
    expect(statuses).not.toContain('verifying');
  });

  it('fails and records the reason when the GitHub step throws', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const orch = new Orchestrator(buildDeps({ githubThrows: true }));
    const job = await orch.startJobForReview('rev_1');
    await orch.settle(job.id);
    const final = (await repositories.jobs.get(job.id))!;
    expect(final.status).toBe('failed');
    expect(final.failureReason).toMatch(/gh failed/);
    // Worktree kept for inspection after a failed push.
    expect(removed).toHaveLength(0);
  });

  it('marks interrupted nonterminal jobs as failed on recovery', async () => {
    await repositories.reviews.insert(makeReview('rev_1'));
    const now = new Date().toISOString();
    await repositories.jobs.insert({
      id: entityId('job'),
      reviewId: 'rev_1',
      projectId: 'proj_1',
      status: 'running-agent',
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    const orch = new Orchestrator(buildDeps());
    const count = await orch.recoverInterrupted();
    expect(count).toBe(1);
    const jobs = await repositories.jobs.list();
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].failureReason).toMatch(/interrupt/i);
  });
});
