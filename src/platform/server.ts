import express, { type Express } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiRouter, type OrchestratorLike } from '../feedback/routes';
import { createReviewMiddleware } from '../preview/routes';
import { proxyAssetFallback } from '../preview/proxy';
import { PINPOINT_BASE } from '../preview/constants';
import type { Repositories } from '../feedback/storage/repositories';
import type { PreviewRegistry } from '../preview/registry';

function assetDir(relativePath: string, marker: string): string {
  const candidates = [
    join(__dirname, '..', relativePath),
    join(__dirname, '..', '..', 'src', relativePath),
    join(process.cwd(), 'src', relativePath),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, marker))) return dir;
  }
  return candidates[0];
}

function overlayDir(): string {
  // Marker is overlay.css (a stable committed file); overlay.bundle.js is a
  // generated artifact that may not exist until the build step has run.
  return assetDir(join('preview', 'overlay'), 'overlay.css');
}

function dashboardDir(): string {
  return assetDir(join('feedback', 'dashboard'), 'dashboard.html');
}
export type { OrchestratorLike };

export interface ServerDeps {
  repositories: Repositories;
  previews: PreviewRegistry;
  /** Token required for developer dashboard routes. */
  devToken: string;
  /** The live job orchestrator wired by the CLI; absent leaves job routes disabled. */
  orchestrator?: OrchestratorLike;
}

/** True only for direct loopback clients. IPv4-mapped IPv6 is common on Windows. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Compose the full Pinpoint Express application. */
export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Expose the preview registry so the HTTP server can resolve WebSocket
  // upgrades for framework previews without re-plumbing dependencies.
  app.locals.previews = deps.previews;

  // Pinpoint's own JSON API (submission + token-protected dashboard/jobs),
  // namespaced under the pinpoint prefix so it never collides with the reviewed
  // app's own /api/* routes — those must proxy through to the app's dev server.
  app.use(`${PINPOINT_BASE}/api`, express.json({ limit: '2mb' }), createApiRouter(deps));

  // Pinpoint-owned browser assets (overlay + dashboard scripts/styles). Two
  // dirs are mounted at the same prefix: the overlay bundle/css and the
  // dashboard css/js live in separate source folders but are all served under
  // PINPOINT_BASE. Express tries each in turn; the filenames don't overlap.
  app.use(PINPOINT_BASE, express.static(overlayDir()));
  app.use(PINPOINT_BASE, express.static(dashboardDir()));

  // Instrumented review preview (static serve or framework proxy).
  app.use('/review', createReviewMiddleware(deps.previews));

  // Developer dashboard shell. Require both a direct loopback connection and
  // the unguessable URL printed by the CLI. Review clients never receive it.
  app.get('/dashboard', (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).send('the developer dashboard is available only from this machine');
      return;
    }
    if (req.query.token !== deps.devToken) {
      res.status(401).send('a valid developer dashboard link is required');
      return;
    }
    const file = join(dashboardDir(), 'dashboard.html');
    if (!existsSync(file)) {
      res.status(404).send('dashboard is not available');
      return;
    }
    const config = JSON.stringify({ devToken: deps.devToken, apiBase: `${PINPOINT_BASE}/api` });
    const html = readFileSync(file, 'utf8').replace(
      '</head>',
      `<script>window.__PINPOINT_DASH__=${config};</script>\n</head>`,
    );
    res.type('text/html; charset=utf-8').send(html);
  });

  // Never reveal the tokenized dashboard URL from a guessable route. The CLI
  // prints the capability URL directly to the developer.
  app.get('/', (_req, res) => res.status(404).send('not found'));

  // Fallback: a proxied framework app requests its assets at root-absolute paths
  // (/_next/*, fonts, /manifest.webmanifest) outside the /review prefix. Forward
  // those to the owning preview's dev server; otherwise 404. Must be last so it
  // only handles paths no earlier route claimed.
  app.use(proxyAssetFallback(deps.previews));

  return app;
}
