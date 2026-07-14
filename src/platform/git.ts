import { runProcess } from './process';

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run Git with consistent output trimming and timeout handling. */
export async function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  const result = await runProcess('git', args, { cwd, timeoutMs });
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/** Run Git and return stdout, throwing a consistently formatted error on failure. */
export async function runGitOrThrow(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const result = await runGit(cwd, args, timeoutMs);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
