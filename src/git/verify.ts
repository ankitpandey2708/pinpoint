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
 * Run every configured verification gate in the worktree. Absent gates are
 * recorded as skipped and never fail the run. The run passes only when every
 * configured (non-skipped) gate exits successfully. Output is secret-redacted.
 */
export async function verifyRepository(
  info: RepositoryInfo,
  worktreePath: string,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  for (const name of GATE_ORDER) {
    const command = info.commands[name];
    if (!command) {
      checks.push({
        name,
        command: [],
        exitCode: null,
        durationMs: 0,
        ok: true,
        skipped: true,
        output: '',
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const check = await runGate(name, command, worktreePath, options);
    checks.push(check);
    // Stop early on the first hard failure to avoid wasting time.
    if (!check.ok) {
      // Mark remaining configured gates as skipped-not-run.
      for (const rest of GATE_ORDER.slice(GATE_ORDER.indexOf(name) + 1)) {
        if (info.commands[rest]) {
          checks.push({
            name: rest,
            command: [info.commands[rest]!.command, ...info.commands[rest]!.args],
            exitCode: null,
            durationMs: 0,
            ok: false,
            skipped: true,
            output: '[pinpoint] not run because an earlier gate failed',
          });
        } else {
          checks.push({ name: rest, command: [], exitCode: null, durationMs: 0, ok: true, skipped: true, output: '' });
        }
      }
      break;
    }
  }

  const ok = checks.every((c) => c.skipped || c.ok);
  return { ok, checks };
}
