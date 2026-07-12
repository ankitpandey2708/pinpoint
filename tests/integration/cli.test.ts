import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram, startReview, type ReviewServices } from '../../src/cli/review';
import type { CodingAgent } from '../../src/agents/types';
import type { RepositoryInfo } from '../../src/domain/types';

let root: string;
let stopped: boolean;
let closed: boolean;

const info: RepositoryInfo = {
  root: '/repo',
  clean: true,
  branch: 'main',
  commit: 'abcdef123456',
  githubRepo: 'acme/site',
  remoteUrl: 'https://github.com/acme/site.git',
  framework: 'static',
  htmlEntry: 'index.html',
  commands: { test: { command: 'npm', args: ['test'] } },
};

const fakeAgent: CodingAgent = {
  name: 'fake',
  run: async () => ({ ok: true, exitCode: 0, timedOut: false, aborted: false, events: [], log: '', durationMs: 0 }),
};

function services(over: Partial<ReviewServices> = {}): ReviewServices {
  return {
    exists: (p) => p === '/repo',
    inspect: async () => info,
    createWorkspace: async (project) => ({
      id: project.id,
      dir: join(root, 'ws'),
      siteDir: join(root, 'ws', 'site'),
      manifestPath: join(root, 'ws', 'manifest.json'),
      mappings: [],
      project,
      cleanup: async () => {},
    }),
    startPreview: async (ws) => ({
      mode: 'static',
      siteDir: ws.siteDir,
      mappings: [],
      logs: [],
      stop: async () => {
        stopped = true;
      },
    }),
    listen: async (_app, _host, port) => ({
      port: port || 3000,
      close: async () => {
        closed = true;
      },
    }),
    makeAgent: () => fakeAgent,
    dataDir: join(root, 'data'),
    workRoot: join(root, 'previews'),
    worktreesRoot: join(root, 'worktrees'),
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pinpoint-cli-'));
  stopped = false;
  closed = false;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('pinpoint review CLI', () => {
  it('exposes help describing the review command and its options', () => {
    const help = buildProgram(async () => {}).helpInformation();
    expect(help).toMatch(/review/);
    const reviewHelp = buildProgram(async () => {})
      .commands.find((c) => c.name() === 'review')!
      .helpInformation();
    expect(reviewHelp).toMatch(/--host/);
    expect(reviewHelp).toMatch(/--port/);
    expect(reviewHelp).toMatch(/--url/);
  });

  it('rejects a repository path that does not exist', async () => {
    await expect(startReview({ repo: '/nope' }, services())).rejects.toThrow(/does not exist/i);
  });

  it('propagates a dirty-repository inspection error', async () => {
    const dirty = services({
      inspect: async () => {
        throw new Error('The repository working tree must be clean before starting a review.');
      },
    });
    await expect(startReview({ repo: '/repo' }, dirty)).rejects.toThrow(/clean/i);
  });

  it('creates a project record and prints review and dashboard URLs', async () => {
    const running = await startReview({ repo: '/repo' }, services());
    const projects = await running.repositories.projects.list();
    expect(projects).toHaveLength(1);
    expect(projects[0].repoPath).toBe('/repo');
    expect(projects[0].framework).toBe('static');
    expect(projects[0].baseCommit).toBe('abcdef123456');
    expect(running.reviewUrl).toContain(`/review/${projects[0].id}`);
    expect(running.dashboardUrl).toContain('/dashboard');
    await running.close();
  });

  it('defaults to loopback and honors an explicit LAN host', async () => {
    const loop = await startReview({ repo: '/repo' }, services());
    expect((await loop.repositories.projects.list())[0].host).toBe('127.0.0.1');
    await loop.close();

    const lanRoot = root;
    const lan = await startReview({ repo: '/repo', host: '0.0.0.0' }, services({ dataDir: join(lanRoot, 'data2') }));
    expect((await lan.repositories.projects.list())[0].host).toBe('0.0.0.0');
    await lan.close();
  });

  it('records a remote public URL when provided', async () => {
    const running = await startReview({ repo: '/repo', url: 'https://preview.example.com' }, services());
    expect((await running.repositories.projects.list())[0].publicUrl).toBe('https://preview.example.com');
    await running.close();
  });

  it('shuts down the preview and server on close', async () => {
    const running = await startReview({ repo: '/repo' }, services());
    await running.close();
    expect(stopped).toBe(true);
    expect(closed).toBe(true);
  });
});
