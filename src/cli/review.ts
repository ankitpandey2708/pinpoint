import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import type { Express } from 'express';
import { createApp } from '../server/app';
import { PreviewRegistry, type PreviewSession } from '../server/preview-registry';
import { createRepositories, type Repositories } from '../storage/repositories';
import { entityId } from '../lib/ids';
import { createPreviewWorkspace, type PreviewWorkspace, type CreatePreviewOptions } from '../preview/workspace';
import { startPreview, type PreviewRuntime } from '../preview/runtime';
import { inspectRepository } from '../repository/inspect';
import { ClaudeAgent } from '../agents/claude';
import { checkGitHubAuth } from '../github/client';
import {
  Orchestrator,
  realWorktreeAdapter,
  realVerifyAdapter,
  realGithubAdapter,
} from '../jobs/orchestrator';
import type { CodingAgent } from '../agents/types';
import type { Project, RepositoryInfo } from '../domain/types';

export interface ReviewOptions {
  repo: string;
  port?: number;
  host?: string;
  /** Start a public Cloudflare tunnel automatically. Defaults to true. */
  tunnel?: boolean;
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
  worktreesRoot: string;
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

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3000;

  const repositories = await createRepositories(services.dataDir);

  const project: Project = {
    id: entityId('proj'),
    name: info.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project',
    repoPath: info.root,
    githubRepo: info.githubRepo,
    remoteUrl: info.remoteUrl,
    baseBranch: info.branch,
    baseCommit: info.commit,
    framework: info.framework,
    htmlEntry: info.htmlEntry,
    commands: info.commands,
    host,
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
    worktrees: realWorktreeAdapter,
    verifier: realVerifyAdapter,
    github: realGithubAdapter,
    worktreesRoot: services.worktreesRoot,
    logsDir: services.logsDir,
  });
  // Any nonterminal jobs from a previous run are unrecoverable; mark them failed.
  await orchestrator.recoverInterrupted();

  const app = createApp({ repositories, previews, devToken, orchestrator });
  const server = await services.listen(app, host, port);

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
    worktreesRoot: join(runtimeRoot, 'worktrees'),
    logsDir: join(dataRoot, 'data', 'logs'),
  };
}

/** Start a real Node HTTP server and forward WebSocket upgrades to previews. */
async function httpListen(app: Express, host: string, port: number): Promise<ServerHandle> {
  const { createServer } = await import('node:http');
  const { handleUpgrade } = await import('../server/proxy');
  // The registry is closed over by createApp's middleware; upgrades resolve the
  // session per-request from the URL, so we only need the app's registry here.
  const server = createServer(app);
  // Attach upgrade handling using the app-level previews via the request URL.
  server.on('upgrade', (req, socket, head) => {
    // The preview registry is embedded in the review middleware; the proxy's
    // handleUpgrade re-resolves from the URL against the shared registry that
    // createApp used. We look it up through the app locals set below.
    const previews = (app as unknown as { locals: { previews?: import('../server/preview-registry').PreviewRegistry } })
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
    .description('Local-first visual review: turn client feedback into draft GitHub pull requests.');

  program
    .command('review')
    .argument('<repo>', 'path to a clean local Git repository to review')
    .option('--port <port>', 'port to bind the Pinpoint server to', (v) => Number(v))
    .option('--host <host>', 'host to bind to (use 0.0.0.0 to share on your LAN)')
    .option('--no-tunnel', 'do not start a public Cloudflare tunnel')
    .description('Start an instrumented review preview and developer dashboard')
    .action(async (repo: string, options: { port?: number; host?: string; tunnel?: boolean }) => {
      await onReview({ repo, port: options.port, host: options.host, tunnel: options.tunnel });
    });

  return program;
}
