import type { SubmittedReview } from '../domain/types';

export interface PromptInput {
  review: SubmittedReview;
  /** Verification commands (arg arrays) the agent should run before finishing. */
  verificationCommands: string[][];
}

function describeSource(sourceFile?: string, component?: string, line?: number): string {
  if (sourceFile) {
    const loc = line ? `${sourceFile}:${line}` : sourceFile;
    return component ? `${loc} (component ${component})` : loc;
  }
  if (component) return `component ${component}`;
  return 'no confident source mapping — locate it from the context below';
}

/**
 * Build the instruction prompt handed to the coding agent. The prompt groups the
 * client's feedback with server-resolved source mappings and DOM/text context,
 * records the base commit, states the verification expectations, and explicitly
 * forbids any Git history/network operation — Pinpoint owns commit/push/PR.
 */
export function buildAgentPrompt(input: PromptInput): string {
  const { review, verificationCommands } = input;
  const lines: string[] = [];

  lines.push('You are implementing visual feedback on a web project.');
  lines.push('');
  lines.push(
    `This work is based on commit ${review.baseCommit} of ${review.githubRepo ?? 'the local repository'} (branch ${review.baseBranch}).`,
  );
  lines.push(`Reviewer: ${review.reviewerName}. Page route: ${review.route}.`);
  lines.push('');
  lines.push('Apply the following feedback items. Each lists the client comment, the');
  lines.push('resolved source location, and the DOM/text context that identifies the element:');
  lines.push('');

  review.annotations.forEach((a) => {
    const m = a.mapping;
    lines.push(`## ${a.index}. <${a.tag}> — ${describeSource(m.sourceFile, m.component, m.line)}`);
    lines.push(`- Feedback: ${a.comment}`);
    lines.push(`- Mapping confidence: ${m.confidence}`);
    if (m.confidence === 'approximate') {
      lines.push(
        '  (This mapping is APPROXIMATE. Confirm the element from the selector/text before editing.)',
      );
    } else if (m.confidence === 'unresolved') {
      lines.push(
        '  (This mapping is UNRESOLVED. Search the repository using the selector/text to find the right file.)',
      );
    }
    lines.push(`- CSS selector: ${a.selector}`);
    if (a.classes.length) lines.push(`- Classes: ${a.classes.join(' ')}`);
    if (a.visibleText) lines.push(`- Visible text: "${a.visibleText}"`);
    if (a.nearbyText) lines.push(`- Nearby text: "${a.nearbyText}"`);
    lines.push('');
  });

  lines.push('## Scope and rules');
  lines.push('- Make ONLY the changes required by the feedback above. Do not make unrelated');
  lines.push('  edits, refactors, or dependency changes. Keep the change tightly scoped.');
  lines.push('- Stay within this working directory (worktree). Do not touch files outside it.');
  lines.push('');
  lines.push('## Verification');
  lines.push('Before you finish, run these commands and make sure they pass:');
  verificationCommands.forEach((cmd) => lines.push(`- ${cmd.join(' ')}`));
  lines.push('');
  lines.push('## Prohibited actions');
  lines.push('- Do NOT run any git commit, git push, git branch, or git history/network command.');
  lines.push('- Do NOT create, update, or merge a pull request (no gh pr / PR operations).');
  lines.push('- Pinpoint performs commit, push, and draft PR creation itself after verifying your work.');

  return lines.join('\n');
}
