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
  /** Streamed sanitized stderr chunks (already redacted). */
  onStderr?: (chunk: string) => void;
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

/**
 * Quote a single token for a cmd.exe command line: wrap in double quotes when it
 * contains whitespace or a cmd metacharacter, doubling embedded quotes. This
 * prevents word-splitting on paths with spaces (e.g. C:\Program Files\...) and
 * neutralizes injection via client-influenced values (e.g. a reviewer name).
 */
function quoteForCmd(token: string): string {
  if (token !== '' && !/[\s"^&|<>()%!]/.test(token)) return token;
  return '"' + token.replace(/"/g, '""') + '"';
}

export interface Spawnable {
  file: string;
  args: string[];
  windowsVerbatim: boolean;
}

/**
 * Decide how to spawn a command. Real binaries (git.exe, gh.exe, node.exe) are
 * spawned directly so Node applies correct CreateProcess quoting. Windows batch
 * shims (npm.cmd, claude.cmd) are run via `cmd.exe /d /s /c "<line>"` where we
 * build and quote the whole line ourselves — never Node's unsafe `shell: true`,
 * which leaves both the executable path and arguments unquoted (DEP0190).
 */
export function buildSpawnable(command: string, args: string[]): Spawnable {
  const { file, isBatch } = resolveExecutable(command);
  if (process.platform === 'win32' && isBatch) {
    const line = [file, ...args].map(quoteForCmd).join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + line + '"'],
      windowsVerbatim: true,
    };
  }
  return { file, args, windowsVerbatim: false };
}

/**
 * Terminate a process tree and resolve once the kill has been dispatched. On
 * Windows we wait for `taskkill /T /F` to exit before resolving — awaiting this
 * matters at shutdown: a fire-and-forget kill lets the parent `process.exit()`
 * win the race and orphan the child tree (holding ports and file locks).
 */
export function killProcessTree(pid: number | undefined, child?: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (pid === undefined) {
      child?.kill('SIGKILL');
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      try {
        const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        tk.once('close', () => resolve());
        tk.once('error', () => {
          child?.kill('SIGKILL');
          resolve();
        });
      } catch {
        child?.kill('SIGKILL');
        resolve();
      }
      return;
    }
    // POSIX: kill the child's process group when it was spawned detached (its
    // pid is the group leader), so the whole dev-server tree dies — not just the
    // top process, leaving grandchildren orphaned. Fall back to the single pid
    // for processes that aren't group leaders (e.g. orphans matched by path
    // during prune).
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    child?.kill('SIGKILL');
    resolve();
  });
}

/**
 * Snapshot running processes as `{ pid, command }` (full command line), so a
 * process can be found by a path in its command line. Best-effort and
 * cross-platform; returns `[]` if enumeration fails. `-ww` keeps `ps` from
 * truncating the command line (deep workspace paths would otherwise be cut off).
 */
async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
  try {
    if (process.platform === 'win32') {
      const res = await runProcess(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { maxOutputBytes: 64 * 1024 * 1024 },
      );
      const parsed = JSON.parse(res.stdout || '[]') as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((p): p is { ProcessId: number; CommandLine: string } =>
          Boolean(p && (p as { CommandLine?: unknown }).CommandLine),
        )
        .map((p) => ({ pid: Number(p.ProcessId), command: String(p.CommandLine) }));
    }
    const res = await runProcess('ps', ['-A', '-ww', '-o', 'pid=,args='], {
      maxOutputBytes: 64 * 1024 * 1024,
    });
    return res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(' ');
        return { pid: Number(line.slice(0, sp)), command: line.slice(sp + 1) };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/**
 * Force-kill (tree-kill) every running process whose command line satisfies
 * `match`, and resolve once all kills are dispatched. One process snapshot;
 * never targets the current process. Returns how many were killed.
 */
export async function killProcessesMatching(match: (command: string) => boolean): Promise<number> {
  const victims = (await listProcesses()).filter((p) => p.pid && p.pid !== process.pid && match(p.command));
  await Promise.all(victims.map((v) => killProcessTree(v.pid)));
  return victims.length;
}

/**
 * Force-kill every process whose command line references any of `paths`
 * (normalized, case-insensitive). Reaps orphaned dev-server trees still rooted
 * in a dead session's workspace so its files unlock before deletion. Returns how
 * many processes were killed.
 */
export function killProcessesReferencing(paths: string[]): Promise<number> {
  const needles = paths.map((p) => p.replace(/\\/g, '/').toLowerCase());
  if (needles.length === 0) return Promise.resolve(0);
  return killProcessesMatching((command) => {
    const cmd = command.replace(/\\/g, '/').toLowerCase();
    return needles.some((n) => cmd.includes(n));
  });
}

/**
 * Spawn a long-running command (e.g. a dev server) using an argument array.
 * Real binaries run without a shell; Windows batch shims (npm.cmd) run through
 * cmd.exe with Node's argument quoting. Callers own the returned process.
 *
 * On POSIX the child is `detached` so it leads its own process group, letting
 * `killProcessTree` terminate the whole tree via `process.kill(-pid)` (Windows
 * uses `taskkill /T` instead, so detaching there would only spawn a new console).
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const spawnable = buildSpawnable(command, args);
  return spawn(spawnable.file, spawnable.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    windowsVerbatimArguments: spawnable.windowsVerbatim,
    detached: process.platform !== 'win32',
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
    onStderr,
  } = options;

  return new Promise<ProcessResult>((resolve) => {
    const started = Date.now();
    const spawnable = buildSpawnable(command, args);

    const child = spawn(spawnable.file, spawnable.args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: spawnable.windowsVerbatim,
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
        if (onStderr) onStderr(redactSecrets(piece));
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
