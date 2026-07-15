import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { runProcess, spawnCommand, killProcessTree, redactSecrets } from '../platform/process';
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

/** Strip ANSI color codes so URLs in colorized dev-server output can be parsed. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** First local URL a dev server prints (e.g. Vite `Local: http://localhost:5173/`). */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i;

/**
 * A response status meaning "a web server is up and responding" — the same set
 * Playwright's `webServer` readiness check accepts. 2xx/3xx cover normal pages
 * and redirects (a 3xx still proves a server is serving); 400–403 cover apps
 * that gate `/` behind auth but are nonetheless live web apps. A 404 or 5xx is
 * treated as not-a-web-app (or not-ready-yet) and retried until the deadline —
 * this is what makes a non-web `dev` script (e.g. a CLI whose `/` 404s) fail
 * cleanly instead of being mistaken for a previewable page.
 */
function isWebServerUp(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status >= 200 && status < 400) return true;
  return status === 400 || status === 401 || status === 402 || status === 403;
}

/**
 * Wait until a dev server serves a web response, resolving to the URL that
 * answered. Each poll prefers the port the server announced in its output
 * (`getDetectedPort`) and falls back to the `PORT` we asked for — so servers
 * that honor PORT (Next, CRA, Nuxt) are reached immediately, and those that pick
 * their own port (Vite, Angular) are reached once they log it. The probe hits
 * 127.0.0.1 to match the loopback proxy connection. Readiness is decided by the
 * response status (see `isWebServerUp`), not the body — inspecting the body is
 * explicitly not how readiness should be judged.
 */
function waitForDevServer(
  getDetectedPort: () => number | undefined,
  fallbackPort: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const port = getDetectedPort() ?? fallbackPort;
      const url = `http://127.0.0.1:${port}`;
      // A connection error or a non-web status (404/5xx) is not ready: retry
      // until the deadline, then fail with a message that names the likely cause.
      const notReady = () => {
        if (Date.now() > deadline) {
          reject(
            new Error(
              `no web server responded at ${url}. Pinpoint previews web frontends: it ` +
                `runs the project's dev script and expects a page served over HTTP. If this ` +
                `project isn't a web app, that is expected.`,
            ),
          );
        } else {
          setTimeout(attempt, 300);
        }
      };
      const req = httpGet(url, (res) => {
        res.resume();
        if (isWebServerUp(res.statusCode)) resolve(url);
        else notReady();
      });
      req.on('error', notReady);
    };
    attempt();
  });
}

/**
 * Start a preview for a workspace. Static projects are served directly by the
 * Pinpoint server, so this returns metadata only. `node` projects install
 * dependencies (if absent) and launch the repo's own dev script, discovering the
 * loopback URL the server bound to, waiting for readiness and capturing
 * sanitized logs.
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
    throw new Error('no dev script was detected for this project');
  }

  // Reserve a free port and offer it via PORT. Servers that honor PORT (Next,
  // CRA, Nuxt, Astro) bind here; those that ignore it (Vite, Angular) pick their
  // own, which we recover from their startup output below. Either way we never
  // inject a --port arg, so wrapped dev scripts (concurrently, custom wrappers)
  // keep working.
  const preferredPort = await freePort();
  const previewCmd = project.commands.preview;
  const child: ChildProcess = spawnCommand(previewCmd.command, previewCmd.args, {
    cwd,
    // BROWSER=none stops dev servers (CRA, some Vite setups) from opening a tab
    // on the host running Pinpoint.
    env: { ...process.env, PORT: String(preferredPort), BROWSER: 'none' },
  });

  // Sniff the port the server announces from its (de-colorized) output. First
  // match wins and is treated as the live port for the readiness probe.
  let detectedPort: number | undefined;
  const capture = (buf: Buffer) => {
    const text = buf.toString('utf8');
    logs.push(redactSecrets(text));
    if (detectedPort === undefined) {
      const match = LOCAL_URL.exec(text.replace(ANSI, ''));
      if (match) detectedPort = Number(match[1]);
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  const stop = async (): Promise<void> => {
    await killProcessTree(child.pid, child);
  };

  // Connect over the loopback IP (avoids localhost's IPv6/IPv4 resolution
  // ambiguity for the readiness probe and the proxy connection). The
  // `Host`/`Origin` headers sent upstream are separately rewritten to
  // `localhost` in proxy.ts, because that — not the connection address — is
  // what a framework dev server's cross-origin protection checks.
  let url: string;
  try {
    url = await waitForDevServer(
      () => detectedPort,
      preferredPort,
      options.readinessTimeoutMs ?? 60_000,
    );
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
