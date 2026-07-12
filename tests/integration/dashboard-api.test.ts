import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, isLoopbackAddress, type OrchestratorLike } from '../../src/server/app';
import { createRepositories, type Repositories } from '../../src/storage/repositories';
import { PreviewRegistry } from '../../src/server/preview-registry';
import { entityId } from '../../src/lib/ids';
import type { Project, SubmittedReview, Annotation, AgentJob } from '../../src/domain/types';
import type { Express } from 'express';

let dataDir: string;
let repositories: Repositories;
let previews: PreviewRegistry;
let app: Express;
let started: string[];

const DEV_TOKEN = 'devtok';

const project: Project = {
  id: 'proj_1',
  name: 'demo',
  repoPath: 'C:/demo',
  githubRepo: 'acme/site',
  baseBranch: 'main',
  baseCommit: 'c0ffee',
  framework: 'static',
  htmlEntry: 'index.html',
  commands: {},
  host: '127.0.0.1',
  port: 3000,
  createdAt: new Date().toISOString(),
};

function annotation(id: string, confidence: Annotation['mapping']['confidence']): Annotation {
  return {
    id,
    index: 1,
    elementId: 'e1',
    route: '/',
    selector: 'h1',
    tag: 'h1',
    classes: [],
    visibleText: 'Pricing',
    nearbyText: '',
    comment: 'Make it bigger',
    mapping: { elementId: 'e1', sourceFile: 'index.html', line: 5, column: 2, tag: 'h1', confidence },
  };
}

function review(id: string, confidence: Annotation['mapping']['confidence']): SubmittedReview {
  return {
    id,
    projectId: 'proj_1',
    reviewerName: 'Alice',
    githubRepo: 'acme/site',
    baseBranch: 'main',
    baseCommit: 'c0ffee',
    framework: 'static',
    route: '/',
    annotations: [annotation(entityId('ann'), confidence)],
    createdAt: new Date().toISOString(),
  };
}

// A fake orchestrator that records the review it was asked to run and inserts a
// queued job, mirroring the real orchestrator's persistence contract.
const orchestrator: OrchestratorLike = {
  async startJobForReview(reviewId: string): Promise<AgentJob> {
    started.push(reviewId);
    const rev = await repositories.reviews.get(reviewId);
    const now = new Date().toISOString();
    const job: AgentJob = {
      id: entityId('job'),
      reviewId,
      projectId: rev!.projectId,
      status: 'queued',
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    };
    return repositories.jobs.insert(job);
  },
  async getJob(jobId: string): Promise<AgentJob | undefined> {
    return repositories.jobs.get(jobId);
  },
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pinpoint-dash-'));
  repositories = await createRepositories(dataDir);
  await repositories.projects.insert(project);
  previews = new PreviewRegistry();
  started = [];
  app = createApp({ repositories, previews, devToken: DEV_TOKEN, orchestrator });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('dashboard read APIs', () => {
  it('recognizes only loopback addresses as local dashboard clients', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.25')).toBe(false);
    expect(isLoopbackAddress('203.0.113.10')).toBe(false);
  });

  it('rejects dashboard read APIs without the developer token', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).get('/api/reviews')).status).toBe(401);
    expect((await request(app).get('/api/reviews/rev_1')).status).toBe(401);
    expect((await request(app).get('/api/jobs/job_1')).status).toBe(401);
  });

  it('lists projects', async () => {
    const res = await request(app).get('/api/projects').set('x-pinpoint-token', DEV_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('proj_1');
    expect(res.body[0].name).toBe('demo');
  });

  it('lists review summaries with annotation counts', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const res = await request(app).get('/api/reviews').set('x-pinpoint-token', DEV_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('rev_1');
    expect(res.body[0].reviewerName).toBe('Alice');
    expect(res.body[0].annotationCount).toBe(1);
  });

  it('returns full review detail with mappings and confidence', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const res = await request(app).get('/api/reviews/rev_1').set('x-pinpoint-token', DEV_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.review.id).toBe('rev_1');
    expect(res.body.review.annotations[0].mapping.sourceFile).toBe('index.html');
    expect(res.body.review.annotations[0].mapping.confidence).toBe('direct');
    expect(res.body.job).toBeNull();
  });

  it('returns 404 for an unknown review detail', async () => {
    const res = await request(app).get('/api/reviews/nope').set('x-pinpoint-token', DEV_TOKEN);
    expect(res.status).toBe(404);
  });

  it('returns a job by id and 404 for unknown jobs', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const create = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    const jobId = create.body.id as string;
    const ok = await request(app).get(`/api/jobs/${jobId}`).set('x-pinpoint-token', DEV_TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(jobId);
    expect(ok.body.status).toBe('queued');
    const missing = await request(app).get('/api/jobs/nope').set('x-pinpoint-token', DEV_TOKEN);
    expect(missing.status).toBe(404);
  });
});

describe('job initiation API', () => {
  it('starts a job for a resolved review', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const res = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.id).toMatch(/^job_/);
    expect(started).toEqual(['rev_1']);
  });

  it('rejects mutation without the developer token', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const res = await request(app).post('/api/reviews/rev_1/jobs').send({});
    expect(res.status).toBe(401);
    expect(started).toHaveLength(0);
  });

  it('refuses to start a job for a missing review', async () => {
    const res = await request(app)
      .post('/api/reviews/nope/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    expect(res.status).toBe(404);
    expect(started).toHaveLength(0);
  });

  it('refuses to start a job for a fully unresolved review', async () => {
    await repositories.reviews.insert(review('rev_1', 'unresolved'));
    const res = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('prevents a duplicate job while one is already active', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const first = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    expect(first.status).toBe(202);
    const second = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    expect(second.status).toBe(409);
    expect(started).toEqual(['rev_1']);
  });

  it('allows a retry after a failed job', async () => {
    await repositories.reviews.insert(review('rev_1', 'direct'));
    const first = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    await repositories.jobs.update(first.body.id, { status: 'failed', failureReason: 'boom' });
    const retry = await request(app)
      .post('/api/reviews/rev_1/jobs')
      .set('x-pinpoint-token', DEV_TOKEN)
      .send({});
    expect(retry.status).toBe(202);
    expect(started).toEqual(['rev_1', 'rev_1']);
  });
});
