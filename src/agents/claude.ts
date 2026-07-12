import { appendFile } from 'node:fs/promises';
import { runProcess } from '../lib/process';
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
}

/** Flags for the installed Claude Code CLI, in noninteractive edit mode. */
function claudeArgs(): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    // The CLI requires --verbose when combining --print with stream-json output.
    '--verbose',
    '--no-session-persistence',
    '--max-turns',
    '30',
    '--permission-mode',
    'acceptEdits',
    // Pinpoint owns all command execution, verification, Git, and GitHub work.
    // Claude may only inspect and edit files inside the isolated worktree.
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

  constructor(options: ClaudeAgentOptions = {}) {
    this.command = options.command ?? ['claude'];
  }

  async run(task: AgentTask, options: AgentRunOptions = {}): Promise<AgentResult> {
    const base = this.command;
    const args = [...base.slice(1), ...claudeArgs()];

    const events: AgentEvent[] = [];
    let buffer = '';

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
      env: options.env,
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
    });

    // Flush any trailing partial line.
    if (buffer.trim()) handleLine(buffer);

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
