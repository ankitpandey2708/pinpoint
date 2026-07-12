import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewWorkspace } from '../../src/preview/workspace';
import { startPreview } from '../../src/preview/runtime';
import type { Project } from '../../src/domain/types';

let srcDir: string;
let workRoot: string;

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), 'pinpoint-src-'));
  workRoot = await mkdtemp(join(tmpdir(), 'pinpoint-work-'));
  await writeFile(
    join(srcDir, 'index.html'),
    '<!doctype html><html><head></head><body><h1>Hi</h1><p>text</p></body></html>',
    'utf8',
  );
});

afterEach(async () => {
  await rm(srcDir, { recursive: true, force: true });
  await rm(workRoot, { recursive: true, force: true });
});

function project(): Project {
  return {
    id: 'proj_static',
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

describe('startPreview (static)', () => {
  it('returns static mode with the served instrumented directory and mappings', async () => {
    const ws = await createPreviewWorkspace(project(), { workRoot });
    const runtime = await startPreview(ws, project());
    try {
      expect(runtime.mode).toBe('static');
      expect(runtime.siteDir).toBe(ws.siteDir);
      expect(runtime.mappings.length).toBeGreaterThan(0);
      const served = await readFile(join(runtime.siteDir!, 'index.html'), 'utf8');
      expect(served).toMatch(/data-pinpoint-id/);
      expect(served).toContain('/__pinpoint__/overlay.js');
    } finally {
      await runtime.stop();
    }
  });
});
