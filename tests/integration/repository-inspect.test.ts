import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepository } from '../../src/repository/inspect';

let dir: string;

function git(args: string[], cwd = dir): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function initRepo(): Promise<void> {
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
}

async function commitAll(): Promise<void> {
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinpoint-inspect-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('inspectRepository', () => {
  it('detects a clean static HTML repository and captures branch/commit', async () => {
    await initRepo();
    await writeFile(join(dir, 'index.html'), '<!doctype html><h1>hi</h1>', 'utf8');
    await commitAll();

    const info = await inspectRepository(dir);
    expect(info.framework).toBe('static');
    expect(info.clean).toBe(true);
    expect(info.branch).toBe('main');
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(info.htmlEntry).toBe('index.html');
  });

  it('rejects a dirty working tree', async () => {
    await initRepo();
    await writeFile(join(dir, 'index.html'), '<h1>hi</h1>', 'utf8');
    await commitAll();
    await writeFile(join(dir, 'dirty.txt'), 'uncommitted', 'utf8');

    await expect(inspectRepository(dir)).rejects.toThrow(/clean/i);
  });

  it('returns no githubRepo when origin is missing', async () => {
    await initRepo();
    await writeFile(join(dir, 'index.html'), '<h1>hi</h1>', 'utf8');
    await commitAll();

    const info = await inspectRepository(dir);
    expect(info.githubRepo).toBeUndefined();
  });

  it('normalizes an https github remote to owner/repo', async () => {
    await initRepo();
    await writeFile(join(dir, 'index.html'), '<h1>hi</h1>', 'utf8');
    await commitAll();
    git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);

    const info = await inspectRepository(dir);
    expect(info.githubRepo).toBe('acme/widgets');
  });

  it('normalizes an ssh github remote to owner/repo', async () => {
    await initRepo();
    await writeFile(join(dir, 'index.html'), '<h1>hi</h1>', 'utf8');
    await commitAll();
    git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);

    const info = await inspectRepository(dir);
    expect(info.githubRepo).toBe('acme/widgets');
  });

  it('detects a React repository', async () => {
    await initRepo();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' },
      }),
      'utf8',
    );
    await commitAll();

    const info = await inspectRepository(dir);
    expect(info.framework).toBe('react');
    expect(info.commands.build).toEqual({ command: 'npm', args: ['run', 'build'] });
    expect(info.commands.test).toEqual({ command: 'npm', args: ['test'] });
    expect(info.commands.preview?.command).toBe('npm');
    expect(info.commands.preview?.args).toContain('--host');
  });

  it('detects a Next.js repository before React', async () => {
    await initRepo();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
        scripts: { dev: 'next dev', build: 'next build' },
      }),
      'utf8',
    );
    await commitAll();

    const info = await inspectRepository(dir);
    expect(info.framework).toBe('next');
    expect(info.commands.preview?.args).toContain('--hostname');
  });

  it('discovers lint and typecheck scripts when present', async () => {
    await initRepo();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: { react: '^18.0.0' },
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' },
      }),
      'utf8',
    );
    await mkdir(join(dir, 'src'), { recursive: true });
    await commitAll();

    const info = await inspectRepository(dir);
    expect(info.commands.lint).toEqual({ command: 'npm', args: ['run', 'lint'] });
    expect(info.commands.typecheck).toEqual({ command: 'npm', args: ['run', 'typecheck'] });
  });
});
