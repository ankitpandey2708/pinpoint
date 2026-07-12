import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '../../src/storage/repositories';
import type { Project, SubmittedReview, AgentJob } from '../../src/domain/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinpoint-repos-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sampleProject(): Project {
  return {
    id: 'proj_1',
    name: 'demo',
    repoPath: 'C:/demo',
    baseBranch: 'main',
    baseCommit: 'abc123',
    framework: 'static',
    commands: {},
    host: '127.0.0.1',
    port: 3000,
    createdAt: new Date().toISOString(),
  };
}

describe('createRepositories', () => {
  it('exposes projects, reviews, and jobs stores backed by JSON files', async () => {
    const repos = await createRepositories(dir);
    await repos.projects.insert(sampleProject());

    const review: SubmittedReview = {
      id: 'rev_1',
      projectId: 'proj_1',
      reviewerName: 'Alice',
      baseBranch: 'main',
      baseCommit: 'abc123',
      framework: 'static',
      route: '/',
      annotations: [],
      createdAt: new Date().toISOString(),
    };
    await repos.reviews.insert(review);

    const job: AgentJob = {
      id: 'job_1',
      reviewId: 'rev_1',
      projectId: 'proj_1',
      status: 'queued',
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repos.jobs.insert(job);

    expect(await repos.projects.get('proj_1')).toBeTruthy();
    expect(await repos.reviews.get('rev_1')).toBeTruthy();
    expect(await repos.jobs.get('job_1')).toBeTruthy();

    // Files exist on disk under the data directory.
    await expect(stat(join(dir, 'projects.json'))).resolves.toBeTruthy();
    await expect(stat(join(dir, 'reviews.json'))).resolves.toBeTruthy();
    await expect(stat(join(dir, 'jobs.json'))).resolves.toBeTruthy();
  });
});
