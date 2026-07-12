import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { instrumentHtml } from '../instrumentation/html';
import { instrumentJsx } from '../instrumentation/jsx';
import { EXCLUDED_DIRS, OVERLAY_URLS } from './constants';
import type { Project, SourceMapping } from '../domain/types';

export interface PreviewWorkspace {
  id: string;
  /** The workspace root (`<workRoot>/<project-id>`). */
  dir: string;
  /** The served copy of the repository. */
  siteDir: string;
  /** Private mapping manifest, kept outside the served root. */
  manifestPath: string;
  mappings: SourceMapping[];
  project: Project;
  cleanup(): Promise<void>;
}

export interface CreatePreviewOptions {
  /** Base directory under which per-project workspaces are created. */
  workRoot: string;
}

const HTML_EXT = /\.html?$/i;
const JSX_EXT = /\.(jsx|tsx)$/i;

function isExcluded(srcRoot: string, source: string): boolean {
  const rel = relative(srcRoot, source);
  if (rel === '') return false;
  return rel.split(sep).some((segment) => EXCLUDED_DIRS.has(segment));
}

/**
 * Create an isolated, instrumented copy of a project's repository. The original
 * repository is never modified: files are copied into `<workRoot>/<id>/site`
 * (excluding build/vendor dirs), then HTML or JSX/TSX inside the copy is
 * instrumented. A private manifest of mappings is written outside the served
 * root so review clients cannot fetch it.
 */
export async function createPreviewWorkspace(
  project: Project,
  options: CreatePreviewOptions,
): Promise<PreviewWorkspace> {
  const dir = join(options.workRoot, project.id);
  const siteDir = join(dir, 'site');
  const manifestPath = join(dir, 'manifest.json');

  await rm(dir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });

  await cp(project.repoPath, siteDir, {
    recursive: true,
    filter: (source) => !isExcluded(project.repoPath, source),
  });

  const mappings =
    project.framework === 'static'
      ? await instrumentStatic(siteDir)
      : await instrumentSources(siteDir);

  await writeFile(manifestPath, JSON.stringify({ mappings }, null, 2), 'utf8');

  return {
    id: project.id,
    dir,
    siteDir,
    manifestPath,
    mappings,
    project,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const parent = (entry as unknown as { parentPath?: string; path?: string });
      const base = parent.parentPath ?? parent.path ?? root;
      files.push(join(base, entry.name));
    }
  }
  return files;
}

async function instrumentStatic(siteDir: string): Promise<SourceMapping[]> {
  const files = (await listFiles(siteDir)).filter((f) => HTML_EXT.test(f));
  const mappings: SourceMapping[] = [];
  for (const file of files) {
    const rel = relative(siteDir, file).replace(/\\/g, '/');
    const html = await readFile(file, 'utf8');
    const result = instrumentHtml(html, rel, OVERLAY_URLS);
    await writeFile(file, result.content, 'utf8');
    mappings.push(...result.mappings);
  }
  return mappings;
}

async function instrumentSources(siteDir: string): Promise<SourceMapping[]> {
  const files = (await listFiles(siteDir)).filter((f) => JSX_EXT.test(f));
  const mappings: SourceMapping[] = [];
  for (const file of files) {
    const rel = relative(siteDir, file).replace(/\\/g, '/');
    const source = await readFile(file, 'utf8');
    try {
      const result = instrumentJsx(source, rel);
      if (result.mappings.length > 0) {
        await writeFile(file, result.content, 'utf8');
        mappings.push(...result.mappings);
      }
    } catch {
      // Skip files that fail to parse; they are simply not instrumented.
    }
  }
  return mappings;
}
