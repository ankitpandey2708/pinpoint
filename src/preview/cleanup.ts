import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { killProcessesReferencing } from '../platform/process';

/**
 * Temp roots Pinpoint has used for per-session workspaces, across every repo and
 * dataRoot on this machine. `pp` is the current layout (see realServices in
 * ../app/cli); older builds used `pinpoint-runtime`. The kill scope is
 * repo-independent by design — the workspace path is the one signal that
 * identifies a session.
 */
const WORKSPACE_ROOTS = [join(tmpdir(), 'pp'), join(tmpdir(), 'pinpoint-runtime')];

/**
 * Kill every Pinpoint-spawned session on this machine and clear its workspace
 * debris — the blunt manual escape hatch (`pinpoint kill`) for wedged state
 * where a run died without clean teardown and left orphaned dev-server trees
 * (holding ports and file locks) or undeletable workspaces. The on-exit reaping
 * and orphan-only startup prune cover the normal case; this covers the rest.
 *
 * First principle: a session's processes and files all live under a workspace
 * root, so the whole job is kill-what-references-a-root, then delete the roots.
 * Returns the number of processes killed.
 */
export async function killAllSessions(): Promise<number> {
  const killed = await killProcessesReferencing(WORKSPACE_ROOTS);
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
