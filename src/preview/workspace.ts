import { link, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runProcess } from '../platform/process';
import type { Project } from '../app/types';

export interface PreviewWorkspace {
  id: string;
  /** The workspace root (`<workRoot>/<project-id>`). */
  dir: string;
  /** The served copy of the repository. */
  siteDir: string;
  project: Project;
  cleanup(): Promise<void>;
}

export interface CreatePreviewOptions {
  /** Base directory under which per-project workspaces are created. */
  workRoot: string;
}

// Files that must never be served to a review client, even if a repository has
// committed them. The preview can be exposed publicly through a tunnel, so this
// is defense-in-depth on top of the repo's own .gitignore.
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.(?:npmrc|yarnrc|pnpmrc|netrc)|.*\.(?:pem|key|p12|pfx))$/i;

/**
 * Create an isolated copy of a project's repository to serve the preview from.
 * The original repository is never modified, and no source files are rewritten:
 * click-to-source mapping happens at runtime (element-source) / at serve time,
 * not via build-time instrumentation.
 *
 * The copy is a detached `git worktree` at the project's base commit rather than
 * a raw file copy. This means the repo's own `.gitignore` decides what is a
 * source file: generated/vendor trees (`node_modules`, `.next`, `dist`, `build`)
 * and ignored data are absent, while every tracked file — including nested data
 * such as `public/data/*.json` that an app imports — is always present. There is
 * no hand-maintained denylist to drift out of sync with a given repository.
 *
 * The repository's installed `node_modules` is reused by hard-linking it so the
 * dev server boots without a fresh install.
 */
export async function createPreviewWorkspace(
  project: Project,
  options: CreatePreviewOptions,
): Promise<PreviewWorkspace> {
  const dir = join(options.workRoot, project.id);
  const siteDir = join(dir, 'site');

  // Garbage-collect workspaces left by previous runs that died without cleanup
  // (e.g. a hard kill), then clear any remnant for this project id.
  await pruneStaleWorkspaces(options.workRoot);
  await destroyWorkspace(project.repoPath, dir, siteDir);
  await mkdir(dir, { recursive: true });
  // Record ownership so a later run's prune can distinguish a live session from
  // a crashed one. Written in `dir`, outside the served `site` root.
  await writeFile(
    join(dir, 'owner.json'),
    JSON.stringify({ pid: process.pid, repoPath: project.repoPath }),
    'utf8',
  );

  const add = await runProcess(
    'git',
    ['-C', project.repoPath, 'worktree', 'add', '--detach', siteDir, project.baseCommit],
    { timeoutMs: 60_000 },
  );
  if (add.code !== 0) {
    throw new Error(`failed to create preview worktree: ${(add.stderr || add.stdout).trim()}`);
  }

  // Reuse the repository's already-installed dependencies. The worktree is at
  // the same commit as the repo, so the lockfile — and thus the whole dependency
  // tree — is identical; the reuse is exact. Dependencies are hard-linked, not
  // symlinked: bundlers such as Next's Turbopack reject a node_modules symlink
  // that escapes the project root, whereas hard links are ordinary files inside
  // the worktree, so they are accepted while copying no data and running no
  // install. Static previews need none. A failed link (e.g. a cross-volume
  // workspace) leaves node_modules absent, so startPreview falls back to install.
  const repoModules = join(project.repoPath, 'node_modules');
  const destModules = join(siteDir, 'node_modules');
  // Skip when the checkout already has node_modules (a repo that commits its
  // dependencies): the worktree is at the same commit, so those are the right
  // versions and re-linking would only collide with them.
  if (project.framework !== 'static' && existsSync(repoModules) && !existsSync(destModules)) {
    await linkNodeModules(repoModules, destModules);
  }

  await scrubSensitive(siteDir);

  return {
    id: project.id,
    dir,
    siteDir,
    project,
    cleanup: () => destroyWorkspace(project.repoPath, dir, siteDir),
  };
}

/**
 * Tear down a preview worktree. node_modules (hard links into the repo) is
 * removed first so `git worktree remove` need not churn through tens of thousands
 * of untracked files; deleting a hard link only drops that directory entry and
 * never touches the repository's real dependencies. Then the worktree is
 * unregistered and its directory removed. Every step is best-effort so a
 * partial/stale state still gets cleaned.
 */
async function destroyWorkspace(repoPath: string, dir: string, siteDir: string): Promise<void> {
  await rm(join(siteDir, 'node_modules'), { recursive: true, force: true }).catch(() => {});
  await runProcess('git', ['-C', repoPath, 'worktree', 'remove', '--force', siteDir], {
    timeoutMs: 30_000,
  }).catch(() => {});
  await runProcess('git', ['-C', repoPath, 'worktree', 'prune'], { timeoutMs: 30_000 }).catch(
    () => {},
  );
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Remove preview workspaces left behind by previous runs that exited without
 * cleanup. Each workspace records its owning process id and repo; one whose
 * process is no longer running is torn down, while live sessions — including a
 * concurrent one from another pinpoint instance — are left untouched. A
 * workspace with no ownership record (e.g. from an older build) is treated as
 * stale. Best-effort: a failure to prune one never blocks startup.
 */
async function pruneStaleWorkspaces(workRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(workRoot);
  } catch {
    return; // workRoot does not exist yet: nothing to prune.
  }
  await Promise.all(
    entries.map(async (name) => {
      const dir = join(workRoot, name);
      const owner = await readOwner(dir);
      if (owner && isProcessAlive(owner.pid)) return; // in use by a live session
      await destroyWorkspace(owner?.repoPath ?? '', dir, join(dir, 'site'));
    }),
  );
}

async function readOwner(dir: string): Promise<{ pid: number; repoPath: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')) as unknown;
    if (
      parsed &&
      typeof (parsed as { pid?: unknown }).pid === 'number' &&
      typeof (parsed as { repoPath?: unknown }).repoPath === 'string'
    ) {
      return parsed as { pid: number; repoPath: string };
    }
  } catch {
    /* missing or unreadable: caller treats as stale */
  }
  return undefined;
}

/** True if a process with this id currently exists (signal 0 probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Recreate `srcModules` at `destModules` using hard links for files, so the copy
 * shares the underlying file data (no bytes copied, no install) yet appears as
 * ordinary files — which Turbopack requires. Directories are created and any
 * internal symlinks are recreated relative so they stay within the tree. Returns
 * false if the tree cannot be linked (e.g. a cross-volume `EXDEV`), after
 * removing any partial result, so the caller can fall back to a real install.
 */
async function linkNodeModules(srcModules: string, destModules: string): Promise<boolean> {
  const dirs: string[] = [];
  const files: Array<{ src: string; dest: string; symlink: boolean }> = [];
  try {
    await collectTree(srcModules, destModules, dirs, files);
    // Pre-order collection guarantees parents precede children.
    for (const d of dirs) await mkdir(d, { recursive: true });
    // Link in bounded batches: enough concurrency to saturate the filesystem
    // without exhausting handles. Benchmarked on a ~32k-file node_modules
    // (Windows/NTFS): 64→21s, 512→6s, 1024+→no further gain. 512 sits at the
    // point where NTFS metadata serialization becomes the floor.
    const BATCH = 512;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async ({ src, dest, symlink: isLink }) => {
          if (isLink) {
            const target = await readlink(src);
            await symlink(target, dest).catch(() => {});
          } else {
            await link(src, dest);
          }
        }),
      );
    }
    return true;
  } catch {
    await rm(destModules, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

async function collectTree(
  src: string,
  dest: string,
  dirs: string[],
  files: Array<{ src: string; dest: string; symlink: boolean }>,
): Promise<void> {
  dirs.push(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      await collectTree(s, d, dirs, files);
    } else {
      files.push({ src: s, dest: d, symlink: entry.isSymbolicLink() });
    }
  }
}

/**
 * List regular files under `root`, pruning `node_modules` (present as reused
 * hard links) and `.git` so the sensitive-file scan never descends into
 * dependencies or git internals.
 */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files;
}

async function scrubSensitive(siteDir: string): Promise<void> {
  const files = await listFiles(siteDir);
  await Promise.all(
    files
      .filter((f) => SENSITIVE_FILE.test(basename(f)))
      .map((f) => rm(f, { force: true }).catch(() => {})),
  );
}
