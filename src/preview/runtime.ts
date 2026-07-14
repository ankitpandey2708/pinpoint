import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { runProcess, spawnCommand, killProcessTree, redactSecrets } from '../platform/process';
import { withPort } from './repository';
import type { Project } from '../app/types';
import type { PreviewWorkspace } from './workspace';

export type PreviewMode = 'static' | 'proxy';

export interface PreviewRuntime {
  mode: PreviewMode;
  /** Internal loopback URL of a framework dev server (proxy mode only). */
  url?: string;
  /** Served directory (static mode only). */
  siteDir?: string;
  logs: string[];
  stop(): Promise<void>;
}

export interface StartPreviewOptions {
  /** Skip `npm install` (useful when dependencies already exist). */
  skipInstall?: boolean;
  readinessTimeoutMs?: number;
}

/** Reserve an ephemeral loopback port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = httpGet(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`preview server did not become ready at ${url}`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

/**
 * Start a preview for a workspace. Static projects are served directly by the
 * Pinpoint server, so this returns metadata only. React/Next projects install
 * dependencies and launch the detected dev server on a loopback-only ephemeral
 * port, waiting for readiness and capturing sanitized logs.
 */
export async function startPreview(
  workspace: PreviewWorkspace,
  project: Project,
  options: StartPreviewOptions = {},
): Promise<PreviewRuntime> {
  if (project.framework === 'static') {
    return {
      mode: 'static',
      siteDir: workspace.siteDir,
      logs: [],
      stop: async () => {},
    };
  }

  const logs: string[] = [];
  const cwd = workspace.siteDir;

  // The workspace reuses the repository's node_modules via a junction, so a
  // fresh install is only needed when dependencies are genuinely absent (e.g. a
  // repo that was never installed). This is what turns startup from minutes into
  // seconds for React/Next projects.
  const depsPresent = existsSync(join(cwd, 'node_modules'));
  if (!options.skipInstall && !depsPresent && project.commands.install) {
    const res = await runProcess(project.commands.install.command, project.commands.install.args, {
      cwd,
      timeoutMs: 10 * 60_000,
      onStdout: (chunk) => logs.push(chunk),
    });
    if (res.code !== 0) {
      throw new Error(`dependency install failed (exit ${res.code})`);
    }
  }

  if (!project.commands.preview) {
    throw new Error('no preview command was detected for this framework');
  }

  const port = await freePort();
  const previewCmd = withPort(project.commands.preview, port);
  // Also pass the port via PORT env: Next reads it, and unlike an injected
  // --port arg it survives dev-script wrappers (concurrently, custom scripts).
  const child: ChildProcess = spawnCommand(previewCmd.command, previewCmd.args, {
    cwd,
    env: { ...process.env, PORT: String(port) },
  });

  const capture = (buf: Buffer) => logs.push(redactSecrets(buf.toString('utf8')));
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  // Connect over the loopback IP (matches the freePort reservation and avoids
  // localhost's IPv6/IPv4 resolution ambiguity for the readiness probe and the
  // proxy connection). The `Host`/`Origin` headers sent upstream are separately
  // rewritten to `localhost` in proxy.ts, because that — not the connection
  // address — is what a framework dev server's cross-origin protection checks.
  const url = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    await killProcessTree(child.pid, child);
  };

  try {
    await waitForServer(url, options.readinessTimeoutMs ?? 60_000);
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    mode: 'proxy',
    url,
    logs,
    stop,
  };
}
