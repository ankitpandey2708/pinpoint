import { runProcess } from '../lib/process';
import type { Command, RepositoryInfo, VerificationCheck, VerificationResult } from '../domain/types';

export interface VerifyOptions {
  /** Per-gate timeout. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streamed sanitized output, prefixed with the gate name. */
  onOutput?: (gate: string, chunk: string) => void;
}

const GATE_TIMEOUT = 10 * 60_000;

/** The verification gates Pinpoint runs, in order. `install` runs first. */
const GATE_ORDER: (keyof RepositoryInfo['commands'])[] = ['install', 'test', 'lint', 'typecheck', 'build'];

async function runGate(
  name: string,
  command: Command,
  cwd: string,
  options: VerifyOptions,
): Promise<VerificationCheck> {
  const res = await runProcess(command.command, command.args, {
    cwd,
    timeoutMs: options.timeoutMs ?? GATE_TIMEOUT,
    signal: options.signal,
    onStdout: options.onOutput ? (chunk) => options.onOutput!(name, chunk) : undefined,
  });
  const ok = res.code === 0 && !res.timedOut && !res.aborted;
  let output = res.stdout + (res.stderr ? '\n' + res.stderr : '');
  if (res.timedOut) output += '\n[pinpoint] gate timed out';
  if (res.aborted) output += '\n[pinpoint] gate aborted';
  return {
    name,
    command: [command.command, ...command.args],
    exitCode: res.code,
    durationMs: res.durationMs,
    ok,
    skipped: false,
    output,
  };
}

/**
 * Run the configured verification gates concurrently in the worktree. Absent
 * gates are recorded as skipped and never fail the run. The run passes only when
 * every configured (non-skipped) gate exits successfully. Output is
 * secret-redacted. Gates are independent, so running them in parallel turns the
 * wall-clock cost from the sum of gate durations into the slowest single gate.
 */
export async function verifyRepository(
  info: RepositoryInfo,
  worktreePath: string,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const checks = await Promise.all(
    GATE_ORDER.map(async (name): Promise<VerificationCheck> => {
      const command = info.commands[name];
      if (!command) {
        return { name, command: [], exitCode: null, durationMs: 0, ok: true, skipped: true, output: '' };
      }
      return runGate(name, command, worktreePath, options);
    }),
  );

  const ok = checks.every((c) => c.skipped || c.ok);
  return { ok, checks };
}
