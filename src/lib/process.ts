import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Optional data written to stdin then closed. */
  input?: string;
  /** Streamed sanitized stdout lines (already redacted). */
  onStdout?: (chunk: string) => void;
}

export interface ProcessResult {
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_MAX_OUTPUT = 200_000;

const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub personal / oauth / server / refresh tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace common secret shapes with a placeholder before persistence/logging. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/**
 * Resolve an executable on Windows to a concrete file so we can spawn without a
 * shell for real binaries (git.exe, node.exe). Batch shims (npm.cmd, npx.cmd,
 * gh may be .cmd) are reported so the caller runs them through cmd.exe, which
 * Node requires for .cmd/.bat files. Args always stay an array; we never build
 * a shell string ourselves.
 */
function resolveExecutable(command: string): { file: string; isBatch: boolean } {
  if (process.platform !== 'win32') return { file: command, isBatch: false };
  if (/[\\/]/.test(command) || /\.(exe|cmd|bat|com)$/i.test(command)) {
    return { file: command, isBatch: /\.(cmd|bat)$/i.test(command) };
  }
  const pathExt = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
  const dirs = (process.env.PATH ?? '').split(delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of pathExt) {
      const candidate = join(d, command + ext);
      if (existsSync(candidate)) {
        return { file: candidate, isBatch: /\.(cmd|bat)$/i.test(ext) };
      }
    }
  }
  // Fall back to the bare name run through the shell so .cmd shims still work.
  return { file: command, isBatch: true };
}

/** Terminate a process tree; on Windows uses taskkill for reliable cleanup. */
export function killProcessTree(pid: number | undefined, child?: ChildProcess): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      /* fall through */
    }
  }
  child?.kill('SIGKILL');
}

/**
 * Spawn a long-running command (e.g. a dev server) using an argument array.
 * Real binaries run without a shell; Windows batch shims (npm.cmd) run through
 * cmd.exe with Node's argument quoting. Callers own the returned process.
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const { file, isBatch } = resolveExecutable(command);
  return spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: isBatch,
    windowsHide: true,
  });
}

/**
 * Spawn a child process with an argument array (never shell interpolation for
 * real binaries), enforce a timeout and abort signal, cap captured output, and
 * redact secrets. On Windows batch shims run through cmd.exe with Node's own
 * argument quoting.
 */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const {
    cwd,
    env,
    timeoutMs,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    input,
    onStdout,
  } = options;

  return new Promise<ProcessResult>((resolve) => {
    const started = Date.now();
    const { file, isBatch } = resolveExecutable(command);

    const child = spawn(file, args, {
      cwd,
      env: env ?? process.env,
      shell: isBatch,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (buf: string, stream: 'out' | 'err') => {
      const current = stream === 'out' ? stdout : stderr;
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - current.length;
      let piece = buf;
      if (piece.length > remaining) {
        piece = piece.slice(0, remaining);
        truncated = true;
      }
      if (stream === 'out') {
        stdout += piece;
        if (onStdout) onStdout(redactSecrets(piece));
      } else {
        stderr += piece;
      }
    };

    child.stdout?.on('data', (d: Buffer) => append(d.toString('utf8'), 'out'));
    child.stderr?.on('data', (d: Buffer) => append(d.toString('utf8'), 'err'));

    const killTree = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
          });
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    };

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
    }

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        command,
        args,
        code,
        signal: sig,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        timedOut,
        aborted,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', () => finish(null, null));
    child.on('close', (code, sig) => finish(code, sig));

    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}
