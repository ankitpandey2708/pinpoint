// Core domain contracts for Pinpoint. These are the persisted shapes and the
// data exchanged between the client overlay, the server, the orchestrator, and
// the coding agent. Keep them free of runtime dependencies.

export type Framework = 'static' | 'react' | 'next';

export type MappingConfidence = 'direct' | 'approximate' | 'unresolved';

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'running-agent'
  | 'verifying'
  | 'pushing'
  | 'pr-opened'
  | 'failed';

/** An executable command stored as an argument array, never a shell string. */
export interface Command {
  command: string;
  args: string[];
}

/** Commands discovered for a project. `preview` is absent for static sites. */
export interface RepositoryCommands {
  install?: Command;
  test?: Command;
  lint?: Command;
  typecheck?: Command;
  build?: Command;
  preview?: Command;
}

/** Result of inspecting a local repository before a review starts. */
export interface RepositoryInfo {
  root: string;
  clean: boolean;
  branch: string;
  commit: string;
  githubRepo?: string; // owner/repo
  remoteUrl?: string;
  framework: Framework;
  htmlEntry?: string; // relative path to an html entry for static sites
  commands: RepositoryCommands;
}

/** A project is the privately-recorded context for one review session. */
export interface Project {
  id: string;
  name: string;
  repoPath: string; // absolute path to the local repository root
  githubRepo?: string; // owner/repo
  remoteUrl?: string;
  baseBranch: string;
  baseCommit: string;
  framework: Framework;
  htmlEntry?: string;
  commands: RepositoryCommands;
  publicUrl?: string; // remote proxy mode
  host: string;
  port: number;
  createdAt: string;
}

/** Maps an instrumented element id back to a source location. */
export interface SourceMapping {
  elementId: string;
  sourceFile?: string;
  component?: string;
  line?: number;
  column?: number;
  tag: string;
  confidence: MappingConfidence;
}

/**
 * What the client overlay captures per selected element. Contains only
 * presentation context and the reviewer's comment; never source/repo fields.
 */
export interface ClientAnnotation {
  elementId: string;
  route: string;
  selector: string;
  tag: string;
  classes: string[];
  visibleText: string;
  nearbyText: string;
  comment: string;
}

/** A stored annotation: client context plus server-resolved source mapping. */
export interface Annotation {
  id: string;
  index: number; // 1-based pin number
  elementId: string;
  route: string;
  selector: string;
  tag: string;
  classes: string[];
  visibleText: string;
  nearbyText: string;
  comment: string;
  mapping: SourceMapping;
}

/** The client submission payload: reviewer name plus captured annotations. */
export interface ReviewSubmission {
  reviewerName: string;
  annotations: ClientAnnotation[];
}

/** An immutable, submitted review enriched with server-side metadata. */
export interface SubmittedReview {
  id: string;
  projectId: string;
  reviewerName: string;
  githubRepo?: string;
  baseBranch: string;
  baseCommit: string;
  framework: Framework;
  route: string;
  annotations: Annotation[];
  createdAt: string;
}

/** One verification gate that Pinpoint ran (test/lint/typecheck/build). */
export interface VerificationCheck {
  name: string;
  command: string[];
  exitCode: number | null;
  durationMs: number;
  ok: boolean;
  skipped: boolean;
  output: string; // sanitized, capped
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
}

/** A coding job: from queued through draft PR (or failure). */
export interface AgentJob {
  id: string;
  reviewId: string;
  projectId: string;
  status: JobStatus;
  attempts: number;
  branch?: string;
  worktreePath?: string;
  changedFiles?: string[];
  verification?: VerificationResult;
  prUrl?: string;
  prNumber?: number;
  failureReason?: string;
  logPath?: string;
  createdAt: string;
  updatedAt: string;
}
