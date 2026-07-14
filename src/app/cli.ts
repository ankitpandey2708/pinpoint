import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import type { Express } from 'express';
import { createApp } from '../platform/server';
import { PreviewRegistry, type PreviewSession } from '../preview/registry';
import { createRepositories, type Repositories } from '../feedback/storage/repositories';
import { entityId } from '../platform/ids';
import { createPreviewWorkspace, type PreviewWorkspace, type CreatePreviewOptions } from '../preview/workspace';
import { startPreview, type PreviewRuntime } from '../preview/runtime';
import { inspectRepository } from '../preview/repository';
import { ClaudeAgent } from '../automation/agent';
import { checkGitHubAuth } from '../automation/pull-request';
import {
  Orchestrator,
  realRepoAdapter,
  realVerifyAdapter,
  realGithubAdapter,
} from '../automation/orchestrator';
import type { CodingAgent } from '../automation/types';
import type { Project, RepositoryInfo } from './types';

export interface ReviewOptions {
  repo: string;
}

/** A running server handle. */
export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/** Injectable seams so the composition is testable without real IO. */
export interface ReviewServices {
  exists?: (path: string) => boolean;
  inspect: (path: string) => Promise<RepositoryInfo>;
  createWorkspace: (project: Project, opts: CreatePreviewOptions) => Promise<PreviewWorkspace>;
  startPreview: (workspace: PreviewWorkspace, project: Project) => Promise<PreviewRuntime>;
  listen: (app: Express, host: string, port: number) => Promise<ServerHandle>;
  makeAgent: () => CodingAgent;
  /** Preflight the GitHub CLI auth. Omitted in tests; run for repos with a remote. */
  checkGitHubAuth?: () => Promise<void>;
  dataDir: string;
  workRoot: string;
  logsDir?: string;
}

export interface RunningReview {
  project: Project;
  reviewUrl: string;
  dashboardUrl: string;
  devToken: string;
  repositories: Repositories;
  orchestrator: Orchestrator;
  close(): Promise<void>;
}

function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host;
}

/**
 * Compose a full review session: inspect the repository, record a project,
 * create an instrumented preview, wire the orchestrator, and start the server.
 * All external effects go through `services` so the flow is unit-testable.
 */
export async function startReview(opts: ReviewOptions, services: ReviewServices): Promise<RunningReview> {
  const exists = services.exists ?? existsSync;
  if (!exists(opts.repo)) {
    throw new Error(`repository path does not exist: ${opts.repo}`);
  }

  const info = await services.inspect(opts.repo);

  // Fail fast if we can't ultimately open a PR: when the repo has a GitHub
  // remote, the draft-PR step needs an authenticated GitHub CLI. Checking now
  // avoids running an agent only to fail at push time.
  if (info.githubRepo && services.checkGitHubAuth) {
    await services.checkGitHubAuth();
  }

  const host = '127.0.0.1';
  const port = 0; // Let the OS select an available loopback port.

  const repositories = await createRepositories(services.dataDir);

  const project: Project = {
    id: entityId('proj'),
    name: info.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project',
    repoPath: info.root,
    githubRepo: info.githubRepo,
    baseBranch: info.branch,
    baseCommit: info.commit,
    framework: info.framework,
    htmlEntry: info.htmlEntry,
    commands: info.commands,
    port,
    createdAt: new Date().toISOString(),
  };
  await repositories.projects.insert(project);

  const workspace = await services.createWorkspace(project, { workRoot: services.workRoot });
  const runtime = await services.startPreview(workspace, project);

  const previews = new PreviewRegistry();
  const session: PreviewSession = {
    project,
    mode: runtime.mode,
    siteDir: runtime.siteDir,
    proxyUrl: runtime.url,
    mappings: runtime.mappings,
    mappingById: new Map(runtime.mappings.map((m) => [m.elementId, m])),
    stop: async () => {
      await runtime.stop();
      await workspace.cleanup();
    },
  };
  previews.register(session);

  const devToken = randomUUID();
  const orchestrator = new Orchestrator({
    repositories,
    agent: services.makeAgent(),
    repo: realRepoAdapter,
    verifier: realVerifyAdapter,
    github: realGithubAdapter,
    logsDir: services.logsDir,
    // Surface job progress in the server terminal, including elapsed time (from
    // queued) at each stage and the total to the draft PR link.
    onStatus: (job) => {
      const secs = ((Date.now() - Date.parse(job.createdAt)) / 1000).toFixed(1);
      if (job.status === 'pr-opened' && job.prUrl) {
        // eslint-disable-next-line no-console
        console.log(`\n  ✅ Draft PR ready for review ${job.reviewId} in ${secs}s (queued → PR):\n     ${job.prUrl}\n`);
      } else if (job.status === 'failed') {
        // eslint-disable-next-line no-console
        console.log(`\n  ❌ Fix job for review ${job.reviewId} failed after ${secs}s: ${job.failureReason ?? 'unknown'}\n`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`  … review ${job.reviewId}: ${job.status} (+${secs}s)`);
      }
    },
  });
  // Any nonterminal jobs from a previous run are unrecoverable; mark them failed.
  await orchestrator.recoverInterrupted();

  const app = createApp({ repositories, previews, devToken, orchestrator });
  const server = await services.listen(app, host, port);
  project.port = server.port;
  await repositories.projects.update(project.id, { port: server.port });

  const shown = displayHost(host);
  const origin = `http://${shown}:${server.port}`;
  const reviewUrl = `${origin}/review/${project.id}`;
  const dashboardUrl = `${origin}/dashboard?token=${encodeURIComponent(devToken)}`;

  const close = async (): Promise<void> => {
    await orchestrator.settleAll();
    await previews.stopAll();
    await server.close();
  };

  return { project, reviewUrl, dashboardUrl, devToken, repositories, orchestrator, close };
}

/** Real service wiring used by the CLI entry point. */
export function realServices(dataRoot: string): ReviewServices {
  const runtimeKey = createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 12);
  const runtimeRoot = join(tmpdir(), 'pinpoint-runtime', runtimeKey);
  return {
    inspect: inspectRepository,
    createWorkspace: createPreviewWorkspace,
    startPreview: (ws, project) => startPreview(ws, project),
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    listen: httpListen,
    makeAgent: () => new ClaudeAgent(),
    checkGitHubAuth: () => checkGitHubAuth(),
    dataDir: join(dataRoot, 'data'),
    workRoot: join(runtimeRoot, 'previews'),
    logsDir: join(dataRoot, 'data', 'logs'),
  };
}

/** Start a real Node HTTP server and forward WebSocket upgrades to previews. */
async function httpListen(app: Express, host: string, port: number): Promise<ServerHandle> {
  const { createServer } = await import('node:http');
  const { handleUpgrade } = await import('../preview/proxy');
  // The registry is closed over by createApp's middleware; upgrades resolve the
  // session per-request from the URL, so we only need the app's registry here.
  const server = createServer(app);
  // Attach upgrade handling using the app-level previews via the request URL.
  server.on('upgrade', (req, socket, head) => {
    // The preview registry is embedded in the review middleware; the proxy's
    // handleUpgrade re-resolves from the URL against the shared registry that
    // createApp used. We look it up through the app locals set below.
    const previews = (app as unknown as { locals: { previews?: import('../preview/registry').PreviewRegistry } })
      .locals.previews;
    if (!previews || !handleUpgrade(previews, req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Build the Commander program. The review action is injected by the caller. */
export function buildProgram(onReview: (opts: ReviewOptions) => Promise<void>): Command {
  const program = new Command();
  program
    .name('pinpoint')
    .description('Start an instrumented review preview and developer dashboard')
    .argument('[repo]', 'repository to review (defaults to the current directory)')
    .action(async (repo?: string) => {
      await onReview({ repo: repo ?? process.cwd() });
    });

  return program;
}
