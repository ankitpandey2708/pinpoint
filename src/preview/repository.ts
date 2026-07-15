import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from '../platform/git';
import type {
  Command,
  Framework,
  RepositoryCommands,
  RepositoryInfo,
} from '../app/types';

/**
 * Conventional dev-script names, tried in order. These are npm-level script
 * conventions, not framework knowledge: `npm start` is a built-in npm command,
 * `dev` is the near-universal dev-server convention, `serve` a common alias. They
 * require nothing from the repo and name no framework.
 */
const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve'] as const;


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
  packageManager?: string; // Corepack field, e.g. "pnpm@9.1.0"
}

/** Pick the first conventional dev-server script the repo declares. */
function pickDevScript(scripts: Record<string, string> | undefined): string | undefined {
  if (!scripts) return undefined;
  return DEV_SCRIPT_NAMES.find((name) => typeof scripts[name] === 'string' && scripts[name].trim());
}

/**
 * Decide which package-manager binary to drive. We don't maintain a whitelist:
 * every mainstream manager exposes the same `<pm> run <script>` / `<pm> install`
 * interface, so we just need its name. Preference order, most authoritative first:
 *   1. the repo's declared Corepack `packageManager` field ("pnpm@9" → "pnpm"),
 *   2. the lockfile present on disk (each manager defines its own filename),
 *   3. npm as the universal default.
 * A binary name is only accepted if it looks like a bare command (letters, so a
 * malformed field can't inject args or a path); otherwise we fall through.
 */
function detectPackageManager(root: string, pkg: PackageJson | undefined): string {
  const declared = pkg?.packageManager?.split('@')[0]?.trim();
  if (declared && /^[a-z][a-z0-9-]*$/i.test(declared)) return declared;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** `<pm> run <script>` — the invocation form every manager accepts. */
function runScript(pm: string, script: string): Command {
  return { command: pm, args: ['run', script] };
}

/**
 * The manager's install command. `<pm> install` is universal; the one worthwhile
 * special case is npm's `ci`, which is faster and reproducible when a
 * package-lock is present.
 */
function installCommand(pm: string, root: string): Command {
  if (pm === 'npm' && existsSync(join(root, 'package-lock.json'))) {
    return { command: 'npm', args: ['ci'] };
  }
  return { command: pm, args: ['install'] };
}

/**
 * A project is a `node` project (launched via its own dev script) when
 * package.json declares one; otherwise a `static` site if it has an HTML entry.
 * We deliberately do not identify the specific framework — the dev script is the
 * framework-agnostic launch mechanism.
 */
function detectFramework(root: string, pkg: PackageJson | undefined): {
  framework: Framework;
  htmlEntry?: string;
  devScript?: string;
} {
  const devScript = pickDevScript(pkg?.scripts);
  if (devScript) return { framework: 'node', devScript };
  const htmlEntry = findHtmlEntry(root);
  if (htmlEntry) return { framework: 'static', htmlEntry };
  throw new Error(
    'Unsupported project: no runnable "dev"/"start"/"serve" script in package.json ' +
      'and no HTML entry file (index.html) was found.',
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
  devScript: string | undefined,
): RepositoryCommands {
  const commands: RepositoryCommands = {};
  const scripts = pkg?.scripts ?? {};
  const pm = detectPackageManager(root, pkg);

  if (pkg) commands.install = installCommand(pm, root);
  if (scripts.test) commands.test = runScript(pm, 'test');
  if (scripts.lint) commands.lint = runScript(pm, 'lint');
  if (scripts.typecheck) commands.typecheck = runScript(pm, 'typecheck');
  if (scripts.build) commands.build = runScript(pm, 'build');

  // Launch the repo's own dev script. No port arg is injected — startPreview
  // sets PORT for servers that honor it and otherwise discovers the port the
  // server chose from its startup output, so this stays framework-agnostic and
  // survives dev-script wrappers (concurrently, custom scripts) that would eat
  // an injected `-- --port`.
  if (framework === 'node' && devScript) commands.preview = runScript(pm, devScript);
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
  const top = await runGit(path, ['rev-parse', '--show-toplevel'], 15_000);
  if (!top.ok) {
    throw new Error(`Not a Git repository: ${path}`);
  }
  const root = top.stdout.replace(/\\/g, '/');

  const status = await runGit(root, ['status', '--porcelain'], 15_000);
  const clean = status.stdout === '';
  if (!clean) {
    throw new Error(
      'The repository working tree must be clean before starting a review.',
    );
  }

  const branchRes = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 15_000);
  const commitRes = await runGit(root, ['rev-parse', 'HEAD'], 15_000);
  const remoteRes = await runGit(root, ['remote', 'get-url', 'origin'], 15_000);

  const remoteUrl = remoteRes.ok ? remoteRes.stdout : undefined;
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

  const { framework, htmlEntry, devScript } = detectFramework(root, pkg);
  const commands = discoverCommands(root, framework, pkg, devScript);

  return {
    root,
    clean,
    branch: branchRes.stdout,
    commit: commitRes.stdout,
    githubRepo,
    framework,
    htmlEntry,
    commands,
  };
}
