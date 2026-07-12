import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '../lib/process';
import type {
  Command,
  Framework,
  RepositoryCommands,
  RepositoryInfo,
} from '../domain/types';

/** Placeholder token replaced with the chosen loopback port at preview time. */
export const PORT_PLACEHOLDER = '__PORT__';

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const res = await runProcess('git', args, { cwd, timeoutMs: 15_000 });
  return { ok: res.code === 0, out: res.stdout.trim() };
}

/** Normalize a GitHub remote URL (https or ssh) to `owner/repo`. */
export function normalizeGithubRepo(url: string): string | undefined {
  const trimmed = url.trim();
  // git@github.com:owner/repo(.git)
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // https://github.com/owner/repo(.git) or ssh://git@github.com/owner/repo
  const https = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  return undefined;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

function detectFramework(root: string, pkg: PackageJson | undefined): {
  framework: Framework;
  htmlEntry?: string;
} {
  if (pkg) {
    if (hasDep(pkg, 'next')) return { framework: 'next' };
    if (hasDep(pkg, 'react')) return { framework: 'react' };
  }
  const htmlEntry = findHtmlEntry(root);
  if (htmlEntry) return { framework: 'static', htmlEntry };
  throw new Error(
    'Unsupported project: expected a React/Next dependency or an HTML entry file.',
  );
}

function findHtmlEntry(root: string): string | undefined {
  const candidates = ['index.html', join('public', 'index.html'), join('src', 'index.html')];
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) return rel.replace(/\\/g, '/');
  }
  return undefined;
}

function discoverCommands(
  root: string,
  framework: Framework,
  pkg: PackageJson | undefined,
): RepositoryCommands {
  const commands: RepositoryCommands = {};
  const scripts = pkg?.scripts ?? {};

  if (pkg) {
    const useCi = existsSync(join(root, 'package-lock.json'));
    commands.install = { command: 'npm', args: useCi ? ['ci'] : ['install'] };
  }
  if (scripts.test) commands.test = { command: 'npm', args: ['test'] };
  if (scripts.lint) commands.lint = { command: 'npm', args: ['run', 'lint'] };
  if (scripts.typecheck) commands.typecheck = { command: 'npm', args: ['run', 'typecheck'] };
  if (scripts.build) commands.build = { command: 'npm', args: ['run', 'build'] };

  if (framework === 'next') {
    commands.preview = {
      command: 'npm',
      args: ['run', 'dev', '--', '--hostname', '127.0.0.1', '--port', PORT_PLACEHOLDER],
    };
  } else if (framework === 'react') {
    commands.preview = {
      command: 'npm',
      args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', PORT_PLACEHOLDER],
    };
  }
  // static: Pinpoint serves files itself; no preview command.

  return commands;
}

/**
 * Inspect a local Git repository: confirm it is a clean Git repo, capture
 * branch/commit/remote, detect the framework, and discover verification and
 * preview commands. Rejects a dirty working tree. Reads package.json without
 * executing it.
 */
export async function inspectRepository(path: string): Promise<RepositoryInfo> {
  const top = await git(path, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    throw new Error(`Not a Git repository: ${path}`);
  }
  const root = top.out.replace(/\\/g, '/');

  const status = await git(root, ['status', '--porcelain']);
  const clean = status.out === '';
  if (!clean) {
    throw new Error(
      'The repository working tree must be clean before starting a review.',
    );
  }

  const branchRes = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commitRes = await git(root, ['rev-parse', 'HEAD']);
  const remoteRes = await git(root, ['remote', 'get-url', 'origin']);

  const remoteUrl = remoteRes.ok ? remoteRes.out : undefined;
  const githubRepo = remoteUrl ? normalizeGithubRepo(remoteUrl) : undefined;

  let pkg: PackageJson | undefined;
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as PackageJson;
    } catch {
      pkg = undefined;
    }
  }

  const { framework, htmlEntry } = detectFramework(root, pkg);
  const commands = discoverCommands(root, framework, pkg);

  return {
    root,
    clean,
    branch: branchRes.out,
    commit: commitRes.out,
    githubRepo,
    remoteUrl,
    framework,
    htmlEntry,
    commands,
  };
}

/** Substitute the port placeholder in a discovered command. */
export function withPort(command: Command, port: number): Command {
  return {
    command: command.command,
    args: command.args.map((a) => (a === PORT_PLACEHOLDER ? String(port) : a)),
  };
}
