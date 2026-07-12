import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRepository } from '../../src/git/verify';
import type { RepositoryInfo, Command } from '../../src/domain/types';

let dir: string;
const node = process.execPath;

function cmd(script: string): Command {
  return { command: node, args: ['-e', script] };
}

function infoWith(commands: RepositoryInfo['commands']): RepositoryInfo {
  return {
    root: dir,
    clean: true,
    branch: 'main',
    commit: 'abc',
    framework: 'static',
    htmlEntry: 'index.html',
    commands,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinpoint-verify-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('verifyRepository', () => {
  it('passes when every configured gate succeeds and skips absent gates', async () => {
    const result = await verifyRepository(
      infoWith({ test: cmd('process.exit(0)'), build: cmd('process.exit(0)') }),
      dir,
    );
    expect(result.ok).toBe(true);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c]));
    expect(byName.test.ok).toBe(true);
    expect(byName.test.skipped).toBe(false);
    expect(byName.build.ok).toBe(true);
    // Absent gates are recorded as skipped and do not fail the run.
    expect(byName.lint.skipped).toBe(true);
    expect(byName.typecheck.skipped).toBe(true);
  });

  it('fails when a configured gate exits nonzero', async () => {
    const result = await verifyRepository(
      infoWith({ test: cmd('process.exit(0)'), build: cmd('process.exit(1)') }),
      dir,
    );
    expect(result.ok).toBe(false);
    const build = result.checks.find((c) => c.name === 'build')!;
    expect(build.ok).toBe(false);
    expect(build.exitCode).toBe(1);
    expect(build.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails and records a timeout for a hung gate', async () => {
    const result = await verifyRepository(
      infoWith({ test: cmd('setInterval(()=>{},1000)') }),
      dir,
      { timeoutMs: 300 },
    );
    expect(result.ok).toBe(false);
    const test = result.checks.find((c) => c.name === 'test')!;
    expect(test.ok).toBe(false);
  });

  it('captures sanitized command output', async () => {
    const result = await verifyRepository(
      infoWith({ test: cmd('console.log("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leak")') }),
      dir,
    );
    const test = result.checks.find((c) => c.name === 'test')!;
    expect(test.command).toEqual([node, '-e', 'console.log("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leak")']);
    expect(test.output).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(test.output).toContain('[REDACTED]');
  });

  it('passes trivially when no gates are configured', async () => {
    const result = await verifyRepository(infoWith({}), dir);
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.skipped)).toBe(true);
  });
});
