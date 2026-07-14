import { appendFile } from 'node:fs/promises';
import { runProcess } from '../platform/process';
import type {
  AgentEvent,
  AgentResult,
  AgentRunOptions,
  AgentTask,
  CodingAgent,
} from './types';

export interface ClaudeAgentOptions {
  /**
   * The base command used to launch Claude Code. Defaults to `['claude']` so the
   * installed CLI on PATH is used. Tests inject `[node, fakeScript]`.
   */
  command?: string[];
  /**
   * Model for the run. Defaults to `sonnet` (fast + strong at code) rather than
   * the CLI's configured default, which may be a slower model like Opus.
   */
  model?: string;
}

/** Flags for the installed Claude Code CLI, in noninteractive edit mode. */
function claudeArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--model',
    model,
    '--no-session-persistence',
    '--max-turns',
    '15',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
  ];
}

/**
 * Coding agent backed by the Claude Code CLI. It runs strictly inside the
 * supplied worktree, streams sanitized stream-json progress, and never performs
 * Git or PR operations.
 */
export class ClaudeAgent implements CodingAgent {
  readonly name = 'claude-code';
  private readonly command: string[];
  private readonly model: string;

  constructor(options: ClaudeAgentOptions = {}) {
    this.command = options.command ?? ['claude'];
    this.model = options.model ?? 'sonnet';
  }

  async run(task: AgentTask, options: AgentRunOptions = {}): Promise<AgentResult> {
    const base = this.command;
    const args = [
      ...base.slice(1),
      ...claudeArgs(this.model),
      ...(task.systemPrompt ? ['--append-system-prompt', task.systemPrompt] : []),
    ];

    const events: AgentEvent[] = [];
    let buffer = '';
    let errBuffer = '';

    // Surface the Claude CLI's stderr (startup/flag/auth errors) live in the
    // server terminal, line by line, so failures are visible immediately.
    const emitStderr = (chunk: string): void => {
      errBuffer += chunk;
      let idx: number;
      while ((idx = errBuffer.indexOf('\n')) !== -1) {
        const line = errBuffer.slice(0, idx);
        errBuffer = errBuffer.slice(idx + 1);
        if (line.trim()) process.stderr.write('  [claude] ' + line + '\n');
      }
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: AgentEvent | undefined;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
          event = parsed as AgentEvent;
        }
      } catch {
        return; // ignore non-JSON progress noise
      }
      if (!event) return;
      events.push(event);
      options.onEvent?.(event);
    };

    const result = await runProcess(base[0], args, {
      cwd: task.cwd,
      // Disable extended thinking: scoped visual edits don't benefit from it, and
      // it adds per-turn latency. Merge over the inherited env so PATH/auth stay
      // intact. Measured: per-turn latency ~6.2s -> ~3.9s alongside the isolation.
      env: { ...process.env, ...options.env, MAX_THINKING_TOKENS: '0' },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      input: task.prompt,
      onStdout: (chunk) => {
        // chunk is already secret-redacted by runProcess.
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
          if (options.logPath) void appendFile(options.logPath, line + '\n', 'utf8').catch(() => {});
        }
      },
      onStderr: emitStderr,
    });

    // Flush any trailing partial line.
    if (buffer.trim()) handleLine(buffer);
    if (errBuffer.trim()) process.stderr.write('  [claude] ' + errBuffer.trim() + '\n');

    // Persist stderr to the job log too — the CLI reports startup/flag/auth
    // errors there, and onStdout only captured stdout lines.
    if (options.logPath && result.stderr.trim()) {
      await appendFile(options.logPath, '\n[stderr]\n' + result.stderr + '\n', 'utf8').catch(() => {});
    }

    const log = result.stdout + (result.stderr ? '\n' + result.stderr : '');
    const ok = result.code === 0 && !result.timedOut && !result.aborted;

    return {
      ok,
      exitCode: result.code,
      timedOut: result.timedOut,
      aborted: result.aborted,
      events,
      log,
      durationMs: result.durationMs,
    };
  }
}
