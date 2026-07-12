import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewWorkspace } from '../../src/preview/workspace';
import type { Project } from '../../src/domain/types';

let srcDir: string;
let workRoot: string;

const ORIGINAL_HTML = [
  '<!doctype html>',
  '<html><head><title>t</title></head>',
  '<body><header><h1>Hi</h1></header><main><button>Go</button></main></body>',
  '</html>',
].join('\n');

function project(): Project {
  return {
    id: 'proj_prev',
    name: 'demo',
    repoPath: srcDir,
    baseBranch: 'main',
    baseCommit: 'abc',
    framework: 'static',
    htmlEntry: 'index.html',
    commands: {},
    host: '127.0.0.1',
    port: 3000,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), 'pinpoint-src-'));
  workRoot = await mkdtemp(join(tmpdir(), 'pinpoint-work-'));
  await writeFile(join(srcDir, 'index.html'), ORIGINAL_HTML, 'utf8');
  await writeFile(join(srcDir, 'styles.css'), 'body{color:red}', 'utf8');
  await mkdir(join(srcDir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(srcDir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
  await mkdir(join(srcDir, '.git'), { recursive: true });
  await writeFile(join(srcDir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
});

afterEach(async () => {
  await rm(srcDir, { recursive: true, force: true });
  await rm(workRoot, { recursive: true, force: true });
});

describe('createPreviewWorkspace', () => {
  it('leaves the original repository byte-identical', async () => {
    await createPreviewWorkspace(project(), { workRoot });
    const after = await readFile(join(srcDir, 'index.html'), 'utf8');
    expect(after).toBe(ORIGINAL_HTML);
  });

  it('excludes ignored directories from the copy', async () => {
    const ws = await createPreviewWorkspace(project(), { workRoot });
    expect(existsSync(join(ws.siteDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(ws.siteDir, '.git'))).toBe(false);
  });

  it('instruments static HTML in the copy and keeps assets available', async () => {
    const ws = await createPreviewWorkspace(project(), { workRoot });
    const copied = await readFile(join(ws.siteDir, 'index.html'), 'utf8');
    expect(copied).toMatch(/data-pinpoint-id="[0-9a-f]{16}"/);
    expect(copied).toContain('/__pinpoint__/overlay.js');
    expect(existsSync(join(ws.siteDir, 'styles.css'))).toBe(true);
  });

  it('emits mappings and writes a private manifest outside the served root', async () => {
    const ws = await createPreviewWorkspace(project(), { workRoot });
    expect(ws.mappings.length).toBeGreaterThan(0);
    await expect(stat(ws.manifestPath)).resolves.toBeTruthy();
    // Manifest must not live inside the served site directory.
    expect(ws.manifestPath.startsWith(ws.siteDir)).toBe(false);
  });

  it('cleanup removes the workspace but not the source repository', async () => {
    const ws = await createPreviewWorkspace(project(), { workRoot });
    await ws.cleanup();
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(join(srcDir, 'index.html'))).toBe(true);
  });
});
