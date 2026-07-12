import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFile } from 'node:fs/promises';
import { entityId } from '../lib/ids';
import { redactSecrets } from '../lib/process';
import type { Repositories } from '../storage/repositories';
import type { PreviewRegistry } from './preview-registry';
import type { Annotation, ClientAnnotation, SubmittedReview, AgentJob } from '../domain/types';

const MAX_REVIEWER = 120;
const MAX_ANNOTATIONS = 300;
const MAX_COMMENT = 4000;
const MAX_TEXT = 2000;

/** Minimal orchestrator surface the API depends on (Task 11 implements it). */
export interface OrchestratorLike {
  startJobForReview(reviewId: string): Promise<AgentJob>;
  getJob(jobId: string): Promise<AgentJob | undefined>;
}

export interface ApiDeps {
  repositories: Repositories;
  previews: PreviewRegistry;
  /** Token required for developer dashboard mutation routes. */
  devToken?: string;
  /** Present when the CLI wires a live orchestrator; absent in submission-only tests. */
  orchestrator?: OrchestratorLike;
}

/** A job blocks a new one for the same review unless it has already failed. */
function isActiveJob(job: AgentJob): boolean {
  return job.status !== 'failed';
}

/** Latest job (by creation time) recorded for a review, if any. */
function latestJobForReview(jobs: AgentJob[], reviewId: string): AgentJob | undefined {
  return jobs
    .filter((j) => j.reviewId === reviewId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function extractClientAnnotation(raw: unknown): ClientAnnotation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const elementId = typeof r.elementId === 'string' ? r.elementId : '';
  const comment = typeof r.comment === 'string' ? r.comment : '';
  if (!elementId) return undefined;
  return {
    elementId,
    route: str(r.route, 512),
    selector: str(r.selector, 1024),
    tag: str(r.tag, 64),
    classes: Array.isArray(r.classes)
      ? r.classes.filter((c): c is string => typeof c === 'string').slice(0, 50)
      : [],
    visibleText: str(r.visibleText, MAX_TEXT),
    nearbyText: str(r.nearbyText, MAX_TEXT),
    comment,
  };
}

/**
 * Handle a client submission. Only the reviewer name and captured annotations
 * are trusted; all repository/source metadata is resolved server-side from the
 * project and the private preview manifest. Client-supplied technical fields
 * are ignored.
 */
async function submitReview(deps: ApiDeps, req: Request, res: Response): Promise<void> {
  const project = await deps.repositories.projects.get(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'unknown project' });
    return;
  }
  const session = deps.previews.get(project.id);
  if (!session) {
    res.status(409).json({ error: 'preview is not active for this project' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  // Reviewer name is optional; default to Anonymous. Only length is enforced.
  const rawReviewerName = typeof body.reviewerName === 'string' ? body.reviewerName.trim() : '';
  if (rawReviewerName.length > MAX_REVIEWER) {
    res.status(400).json({ error: 'reviewer name is too long' });
    return;
  }
  const reviewerName = rawReviewerName || 'Anonymous';

  const rawAnnotations = Array.isArray(body.annotations) ? body.annotations : [];
  if (rawAnnotations.length === 0 || rawAnnotations.length > MAX_ANNOTATIONS) {
    res.status(400).json({ error: 'at least one annotation is required' });
    return;
  }

  const route = str(body.route, 512) || '/';
  const annotations: Annotation[] = [];
  let index = 0;

  for (const raw of rawAnnotations) {
    const client = extractClientAnnotation(raw);
    if (!client) {
      res.status(400).json({ error: 'invalid annotation' });
      return;
    }
    const comment = client.comment.trim();
    if (!comment || comment.length > MAX_COMMENT) {
      res.status(400).json({ error: 'each annotation needs a non-empty comment' });
      return;
    }
    const mapping = session.mappingById.get(client.elementId);
    if (!mapping) {
      res.status(400).json({ error: `unknown element: ${client.elementId}` });
      return;
    }
    index += 1;
    annotations.push({
      id: entityId('ann'),
      index,
      elementId: client.elementId,
      route: client.route || route,
      selector: client.selector,
      tag: client.tag || mapping.tag,
      classes: client.classes,
      visibleText: client.visibleText,
      nearbyText: client.nearbyText,
      comment,
      mapping: { ...mapping }, // server-resolved; never trust client source fields
    });
  }

  const review: SubmittedReview = {
    id: entityId('rev'),
    projectId: project.id,
    reviewerName,
    githubRepo: project.githubRepo,
    baseBranch: project.baseBranch,
    baseCommit: project.baseCommit,
    framework: project.framework,
    route,
    annotations,
    createdAt: new Date().toISOString(),
  };

  await deps.repositories.reviews.insert(review);

  // Autonomous flow: a submission immediately starts the coding agent. The draft
  // pull request it produces is the human review gate (the system still never
  // auto-merges and never force-pushes). Only fires when an orchestrator is wired
  // and at least one annotation resolved to a source location. A failure to start
  // never fails the client submission — the review is saved and the developer can
  // retry from the dashboard.
  let jobId: string | undefined;
  const hasResolved = annotations.some((a) => a.mapping.confidence !== 'unresolved');
  if (deps.orchestrator && hasResolved) {
    try {
      const job = await deps.orchestrator.startJobForReview(review.id);
      jobId = job.id;
    } catch {
      /* review persisted regardless; dashboard retry remains available */
    }
  }
  res.status(201).json({ id: review.id, jobId });
}

/** Compact review summary for the dashboard list view. */
function summarizeReview(review: SubmittedReview, job?: AgentJob) {
  const resolved = review.annotations.filter((a) => a.mapping.confidence !== 'unresolved').length;
  return {
    id: review.id,
    projectId: review.projectId,
    reviewerName: review.reviewerName,
    route: review.route,
    annotationCount: review.annotations.length,
    resolvedCount: resolved,
    githubRepo: review.githubRepo,
    createdAt: review.createdAt,
    job: job ? { id: job.id, status: job.status } : null,
  };
}

/** Guard mutation routes with the per-server developer token. */
function requireDevToken(deps: ApiDeps, req: Request, res: Response): boolean {
  if (!deps.devToken) return true; // no token configured (e.g. unit tests): allow.
  const provided = req.get('x-pinpoint-token');
  if (provided !== deps.devToken) {
    res.status(401).json({ error: 'a valid developer token is required' });
    return false;
  }
  return true;
}

async function listProjects(deps: ApiDeps, _req: Request, res: Response): Promise<void> {
  res.json(await deps.repositories.projects.list());
}

async function listReviews(deps: ApiDeps, _req: Request, res: Response): Promise<void> {
  const [reviews, jobs] = await Promise.all([
    deps.repositories.reviews.list(),
    deps.repositories.jobs.list(),
  ]);
  const summaries = reviews
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => summarizeReview(r, latestJobForReview(jobs, r.id)));
  res.json(summaries);
}

async function getReviewDetail(deps: ApiDeps, req: Request, res: Response): Promise<void> {
  const review = await deps.repositories.reviews.get(req.params.id);
  if (!review) {
    res.status(404).json({ error: 'unknown review' });
    return;
  }
  const job = latestJobForReview(await deps.repositories.jobs.list(), review.id);
  res.json({ review, job: job ?? null });
}

async function getJob(deps: ApiDeps, req: Request, res: Response): Promise<void> {
  const job = await deps.repositories.jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'unknown job' });
    return;
  }
  res.json(job);
}

/**
 * Return the sanitized agent log for a job. Only the server-recorded log path is
 * read (never a client-supplied path); contents are re-redacted defensively even
 * though they were redacted on write. Missing/absent logs yield an empty string.
 */
async function getJobLog(deps: ApiDeps, req: Request, res: Response): Promise<void> {
  const job = await deps.repositories.jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'unknown job' });
    return;
  }
  if (!job.logPath) {
    res.json({ log: '' });
    return;
  }
  try {
    const log = await readFile(job.logPath, 'utf8');
    res.json({ log: redactSecrets(log) });
  } catch {
    res.json({ log: '' });
  }
}

/**
 * Start a coding job for a review. This is the only client-visible way to run
 * an agent, and it is protected by the developer token. It refuses missing or
 * fully-unresolved reviews and prevents more than one active job per review.
 */
async function startJob(deps: ApiDeps, req: Request, res: Response): Promise<void> {
  if (!requireDevToken(deps, req, res)) return;

  const review = await deps.repositories.reviews.get(req.params.id);
  if (!review) {
    res.status(404).json({ error: 'unknown review' });
    return;
  }

  const hasResolved = review.annotations.some((a) => a.mapping.confidence !== 'unresolved');
  if (!hasResolved) {
    res.status(400).json({ error: 'no annotation resolved to a source location; cannot start a fix' });
    return;
  }

  const jobs = await deps.repositories.jobs.list();
  const existing = jobs.filter((j) => j.reviewId === review.id).find(isActiveJob);
  if (existing) {
    res.status(409).json({ error: 'a job is already active for this review', jobId: existing.id });
    return;
  }

  if (!deps.orchestrator) {
    res.status(503).json({ error: 'job orchestration is not available' });
    return;
  }

  const job = await deps.orchestrator.startJobForReview(review.id);
  res.status(202).json({ id: job.id, status: job.status });
}

export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();

  // Client submission (Task 7).
  router.post('/projects/:projectId/reviews', (req, res, next) => {
    submitReview(deps, req, res).catch(next);
  });

  // Dashboard read APIs (Task 8).
  const wrap =
    (fn: (deps: ApiDeps, req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(deps, req, res).catch(next);
    };

  const developerRead =
    (fn: (deps: ApiDeps, req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      if (!requireDevToken(deps, req, res)) return;
      fn(deps, req, res).catch(next);
    };

  router.get('/projects', developerRead(listProjects));
  router.get('/reviews', developerRead(listReviews));
  router.get('/reviews/:id', developerRead(getReviewDetail));
  router.get('/jobs/:id', developerRead(getJob));
  router.get('/jobs/:id/log', developerRead(getJobLog));

  // Developer-approved job initiation (Task 8, protected).
  router.post('/reviews/:id/jobs', wrap(startJob));

  return router;
}
