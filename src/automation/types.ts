// Replaceable coding-agent interface. Claude Code is the first runner; other
// agents (Codex, OpenCode, Hermes) can implement the same contract later
// without touching the feedback/orchestration layers.

/** A single parsed, sanitized progress event from an agent's stream output. */
export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/** The work handed to an agent: a prepared prompt scoped to one worktree. */
export interface AgentTask {
  /** The per-task user message (see automation/prompt.ts). */
  prompt: string;
  /** Invariant rules appended to the agent's system prompt, if the runner supports it. */
  systemPrompt?: string;
  /** Absolute path to the isolated Git worktree the agent must work in. */
  cwd: string;
}

export interface AgentRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for each sanitized parsed progress event. */
  onEvent?: (event: AgentEvent) => void;
  /** Optional file to append sanitized raw output to. */
  logPath?: string;
  /** Override the environment passed to the agent process. */
  env?: NodeJS.ProcessEnv;
}

export interface AgentResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** Parsed progress events (best effort; non-JSON lines are ignored). */
  events: AgentEvent[];
  /** Full sanitized output, secrets redacted. */
  log: string;
  durationMs: number;
}

export interface CodingAgent {
  readonly name: string;
  run(task: AgentTask, options?: AgentRunOptions): Promise<AgentResult>;
}
