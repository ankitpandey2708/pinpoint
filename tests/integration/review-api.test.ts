import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app';
import { createRepositories, type Repositories } from '../../src/storage/repositories';
import { PreviewRegistry } from '../../src/server/preview-registry';
import type { Project, SourceMapping } from '../../src/domain/types';
import type { Express } from 'express';

let dataDir: string;
let repositories: Repositories;
let previews: PreviewRegistry;
let app: Express;

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

const mappings: SourceMapping[] = [
  { elementId: 'e1', sourceFile: 'index.html', line: 5, column: 2, tag: 'h1', confidence: 'direct' },
  { elementId: 'e2', sourceFile: 'index.html', line: 6, column: 2, tag: 'button', confidence: 'direct' },
];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pinpoint-api-'));
  repositories = await createRepositories(dataDir);
  await repositories.projects.insert(project);
  previews = new PreviewRegistry();
  previews.register({
    project,
    mode: 'static',
    siteDir: 'C:/served',
    mappings,
    mappingById: new Map(mappings.map((m) => [m.elementId, m])),
    stop: async () => {},
  });
  app = createApp({ repositories, previews, devToken: 'devtok' });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function validBody() {
  return {
    reviewerName: 'Alice',
    route: '/',
    annotations: [
      { elementId: 'e1', comment: 'Make the heading bigger', tag: 'h1', selector: 'h1', classes: [], visibleText: 'Pricing', nearbyText: '' },
      { elementId: 'e2', comment: 'Change to Start Free Trial', tag: 'button', selector: 'button.cta', classes: ['cta'], visibleText: 'Sign up', nearbyText: '' },
    ],
  };
}

describe('POST /api/projects/:projectId/reviews', () => {
  it('accepts a valid grouped submission and stores one enriched review', async () => {
    const res = await request(app).post('/api/projects/proj_1/reviews').send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^rev_/);

    const all = await repositories.reviews.list();
    expect(all).toHaveLength(1);
    const review = all[0];
    expect(review.reviewerName).toBe('Alice');
    expect(review.githubRepo).toBe('acme/site');
    expect(review.baseCommit).toBe('c0ffee');
    expect(review.baseBranch).toBe('main');
    expect(review.annotations).toHaveLength(2);
    expect(review.annotations[0].index).toBe(1);
    expect(review.annotations[0].mapping.sourceFile).toBe('index.html');
    expect(review.annotations[0].mapping.tag).toBe('h1');
  });

  it('rejects an empty reviewer name', async () => {
    const body = validBody();
    body.reviewerName = '   ';
    const res = await request(app).post('/api/projects/proj_1/reviews').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects an annotation with an empty comment', async () => {
    const body = validBody();
    body.annotations[0].comment = '';
    const res = await request(app).post('/api/projects/proj_1/reviews').send(body);
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await request(app).post('/api/projects/nope/reviews').send(validBody());
    expect(res.status).toBe(404);
  });

  it('rejects an unknown element id', async () => {
    const body = validBody();
    body.annotations.push({
      elementId: 'e9', comment: 'x', tag: 'div', selector: 'div', classes: [], visibleText: '', nearbyText: '',
    });
    const res = await request(app).post('/api/projects/proj_1/reviews').send(body);
    expect(res.status).toBe(400);
  });

  it('ignores client-supplied source/repository fields and enriches server-side', async () => {
    const body: Record<string, unknown> = {
      reviewerName: 'Mallory',
      githubRepo: 'attacker/evil',
      baseCommit: 'deadbeef',
      annotations: [
        {
          elementId: 'e1',
          comment: 'ok',
          sourceFile: 'HACK.ts',
          component: 'Pwned',
          confidence: 'direct',
          tag: 'span',
        },
      ],
    };
    const res = await request(app).post('/api/projects/proj_1/reviews').send(body);
    expect(res.status).toBe(201);
    const review = (await repositories.reviews.list())[0];
    expect(review.githubRepo).toBe('acme/site');
    expect(review.baseCommit).toBe('c0ffee');
    expect(review.annotations[0].mapping.sourceFile).toBe('index.html');
    expect(review.annotations[0].mapping.component).not.toBe('Pwned');
  });
});
