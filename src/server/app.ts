import express, { type Express } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiRouter, type OrchestratorLike } from './api-routes';
import { createReviewMiddleware } from './review-routes';
import { publicDir } from './assets';
import { PINPOINT_BASE } from '../preview/constants';
import type { Repositories } from '../storage/repositories';
import type { PreviewRegistry } from './preview-registry';

export type { OrchestratorLike };

export interface ServerDeps {
  repositories: Repositories;
  previews: PreviewRegistry;
  /** Token required for developer dashboard mutation routes. */
  devToken: string;
  /** Present when the CLI wires a live orchestrator; absent in some tests. */
  orchestrator?: OrchestratorLike;
}

/** Compose the full Pinpoint Express application. */
export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Pinpoint-owned browser assets (overlay + dashboard scripts/styles).
  app.use(PINPOINT_BASE, express.static(publicDir()));

  // JSON APIs (submission + dashboard + jobs).
  app.use('/api', express.json({ limit: '2mb' }), createApiRouter(deps));

  // Instrumented review preview (static serve or framework proxy).
  app.use('/review', createReviewMiddleware(deps.previews));

  // Developer dashboard shell. The per-server developer token is injected here
  // (loopback-served page only) so mutation routes can be authorized; it is
  // never present in review pages sent to clients.
  app.get('/dashboard', (_req, res) => {
    const file = join(publicDir(), 'dashboard.html');
    if (!existsSync(file)) {
      res.status(404).send('dashboard is not available');
      return;
    }
    const config = JSON.stringify({ devToken: deps.devToken, apiBase: '/api' });
    const html = readFileSync(file, 'utf8').replace(
      '</head>',
      `<script>window.__PINPOINT_DASH__=${config};</script>\n</head>`,
    );
    res.type('text/html; charset=utf-8').send(html);
  });
  app.get('/', (_req, res) => res.redirect('/dashboard'));

  return app;
}
