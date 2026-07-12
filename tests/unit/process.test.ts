import { describe, it, expect } from 'vitest';
import { runProcess, redactSecrets } from '../../src/lib/process';

const NODE = process.execPath;

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const res = await runProcess(NODE, ['-e', 'process.stdout.write("hello")']);
    expect(res.stdout).toBe('hello');
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it('captures a nonzero exit code', async () => {
    const res = await runProcess(NODE, ['-e', 'process.exit(3)']);
    expect(res.code).toBe(3);
  });

  it('captures stderr', async () => {
    const res = await runProcess(NODE, ['-e', 'process.stderr.write("boom")']);
    expect(res.stderr).toBe('boom');
  });

  it('times out and reports timedOut', async () => {
    const res = await runProcess(NODE, ['-e', 'setTimeout(()=>{}, 10000)'], {
      timeoutMs: 250,
    });
    expect(res.timedOut).toBe(true);
    expect(res.code).not.toBe(0);
  });

  it('can be cancelled via an abort signal', async () => {
    const controller = new AbortController();
    const promise = runProcess(NODE, ['-e', 'setTimeout(()=>{}, 10000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const res = await promise;
    expect(res.aborted).toBe(true);
    expect(res.code).not.toBe(0);
  });

  it('caps captured output', async () => {
    const res = await runProcess(
      NODE,
      ['-e', 'process.stdout.write("x".repeat(1000000))'],
      { maxOutputBytes: 1000 },
    );
    expect(res.stdout.length).toBeLessThan(1000 + 200);
    expect(res.truncated).toBe(true);
  });

  it('redacts secrets from captured output', async () => {
    const res = await runProcess(NODE, [
      '-e',
      'process.stdout.write("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")',
    ]);
    expect(res.stdout).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(res.stdout).toContain('[REDACTED]');
  });
});

describe('redactSecrets', () => {
  it('redacts common token shapes', () => {
    expect(redactSecrets('x ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 y')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer abcdef.ghijkl.mnopqr')).toContain('[REDACTED]');
    expect(redactSecrets('password=hunter2secret')).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('the quick brown fox')).toBe('the quick brown fox');
  });
});
