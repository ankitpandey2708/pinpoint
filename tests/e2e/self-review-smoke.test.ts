import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instrumentHtml } from '../../src/instrumentation/html';
import { OVERLAY_URLS } from '../../src/preview/constants';
import { createApp } from '../../src/server/app';
import { createRepositories, type Repositories } from '../../src/storage/repositories';
import { PreviewRegistry } from '../../src/server/preview-registry';
import type { Project } from '../../src/domain/types';
import type { Express } from 'express';

// Task 12 step 3: an automated smoke test of a real review against Pinpoint's own
// landing page. It instruments the actual index.html, selects two elements, and
// submits them through the real submission API, then confirms the dashboard shows
// direct source mappings back to index.html. index.html itself is never modified.
const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8');

let dataDir: string;
let repositories: Repositories;
let app: Express;

const project: Project = {
  id: 'proj_self',
  name: 'pinpoint',
  repoPath: join(__dirname, '../..'),
  githubRepo: 'realfast/pinpoint',
  baseBranch: 'main',
  baseCommit: 'selftest',
  framework: 'static',
  htmlEntry: 'index.html',
  commands: {},
  host: '127.0.0.1',
  port: 3000,
  createdAt: new Date().toISOString(),
};

const { mappings } = instrumentHtml(indexHtml, 'index.html', OVERLAY_URLS);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pinpoint-smoke-'));
  repositories = await createRepositories(dataDir);
  await repositories.projects.insert(project);
  const previews = new PreviewRegistry();
  previews.register({
    project,
    mode: 'static',
    siteDir: join(dataDir, 'site'),
    mappings,
    mappingById: new Map(mappings.map((m) => [m.elementId, m])),
    stop: async () => {},
  });
  app = createApp({ repositories, previews, devToken: 'devtok' });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('self-review smoke against the real landing page', () => {
  it('instruments index.html with direct source mappings', () => {
    expect(mappings.length).toBeGreaterThanOrEqual(2);
    expect(mappings.every((m) => m.sourceFile === 'index.html')).toBe(true);
    expect(mappings.every((m) => m.confidence === 'direct')).toBe(true);
  });

  it('accepts a two-element review and shows direct index.html mappings in the dashboard', async () => {
    const [first, second] = mappings;
    const submit = await request(app)
      .post(`/api/projects/${project.id}/reviews`)
      .send({
        reviewerName: 'Smoke Tester',
        route: '/',
        annotations: [
          { elementId: first.elementId, comment: 'Make this heading bigger', tag: first.tag, selector: first.tag, classes: [], visibleText: 'Heading', nearbyText: '' },
          { elementId: second.elementId, comment: 'Change this button text', tag: second.tag, selector: second.tag, classes: [], visibleText: 'Button', nearbyText: '' },
        ],
      });
    expect(submit.status).toBe(201);
    const reviewId = submit.body.id as string;

    const detail = await request(app)
      .get(`/api/reviews/${reviewId}`)
      .set('x-pinpoint-token', 'devtok');
    expect(detail.status).toBe(200);
    expect(detail.body.review.annotations).toHaveLength(2);
    for (const a of detail.body.review.annotations) {
      expect(a.mapping.sourceFile).toBe('index.html');
      expect(a.mapping.confidence).toBe('direct');
      expect(typeof a.mapping.line).toBe('number');
    }

    // And the review list summarizes it as fully resolved.
    const list = await request(app).get('/api/reviews').set('x-pinpoint-token', 'devtok');
    expect(list.body[0].annotationCount).toBe(2);
    expect(list.body[0].resolvedCount).toBe(2);
  });
});
