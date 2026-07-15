import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { killProcessesMatching } from '../platform/process';

/**
 * Temp roots Pinpoint has used for per-session workspaces, across every repo and
 * dataRoot on this machine. `pp` is the current layout (see realConfig in
 * ../app/cli); older builds used `pinpoint-runtime`.
 */
const WORKSPACE_ROOTS = [join(tmpdir(), 'pp'), join(tmpdir(), 'pinpoint-runtime')];
const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase();
const WORKSPACE_NEEDLES = WORKSPACE_ROOTS.map(norm);

/**
 * True for any process belonging to a Pinpoint session on this machine:
 * - the Pinpoint server itself — it runs the Pinpoint entrypoint, matched by
 *   both `pinpoint` and `app/index.(ts|js)` in its command line so an unrelated
 *   `node app/index.js` elsewhere is never caught. Tree-killing it reaps its
 *   spawned preview and its cloudflared tunnel (both are its children).
 * - a spawned framework dev-server tree (or an orphan of one) — it runs with its
 *   cwd inside a workspace, so its command line references a workspace root.
 */
function isPinpointProcess(command: string): boolean {
  const c = norm(command);
  if (WORKSPACE_NEEDLES.some((n) => c.includes(n))) return true;
  return c.includes('pinpoint') && (c.includes('app/index.ts') || c.includes('app/index.js'));
}

/**
 * Kill every Pinpoint session on this machine — servers, their spawned preview
 * trees, and their cloudflared tunnels — and clear all workspace debris. The
 * blunt manual escape hatch (`pinpoint kill`) for wedged/leftover state; the
 * on-exit reaping and orphan-only startup prune cover the normal case. Never
 * targets the current process. Returns the number of processes killed.
 */
export async function killAllSessions(): Promise<number> {
  const killed = await killProcessesMatching(isPinpointProcess);
  await Promise.all(
    WORKSPACE_ROOTS.map((root) =>
      // The `\\?\` extended-length prefix lets Node delete node_modules trees
      // past Windows' MAX_PATH (260 chars); child paths inherit it.
      rm(process.platform === 'win32' ? `\\\\?\\${resolve(root)}` : root, {
        recursive: true,
        force: true,
      }).catch(() => {}),
    ),
  );
  return killed;
}
