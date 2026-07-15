// Core domain contracts for Pinpoint. These are the persisted shapes and the
// data exchanged between the client overlay, the server, the orchestrator, and
// the coding agent. Keep them free of runtime dependencies.

export type Framework = 'static' | 'node';

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
  baseBranch: string;
  baseCommit: string;
  framework: Framework;
  htmlEntry?: string;
  commands: RepositoryCommands;
  port: number;
  createdAt: string;
}

/** A resolved source frame reported by the client (via element-source). */
export interface ClientSourceFrame {
  filePath: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
}

/** A source location for a selected element (server-validated). */
export interface SourceMapping {
  sourceFile?: string;
  component?: string;
  line?: number;
  column?: number;
  tag: string;
  confidence: MappingConfidence;
}

/**
 * What the client overlay captures per selected element: an element-source
 * `source`/`stack` (empty for static HTML, which has no framework runtime) plus
 * presentation context and the comment — never repo/credential fields.
 */
export interface ClientAnnotation {
  route: string;
  tag: string;
  componentName: string | null;
  source: ClientSourceFrame | null;
  stack: ClientSourceFrame[];
  selector: string;
  outerHtml: string;
  classes: string[];
  visibleText: string;
  nearbyText: string;
  comment: string;
}

/** A stored annotation: client context plus server-resolved source mapping. */
export interface Annotation {
  id: string;
  index: number; // 1-based pin number
  route: string;
  tag: string;
  componentName?: string | null;
  selector: string;
  outerHtml?: string;
  classes: string[];
  visibleText: string;
  nearbyText: string;
  comment: string;
  stack?: ClientSourceFrame[];
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
  changedFiles?: string[];
  verification?: VerificationResult;
  prUrl?: string;
  failureReason?: string;
  logPath?: string;
  createdAt: string;
  updatedAt: string;
}
