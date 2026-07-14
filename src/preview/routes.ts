import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { normalize, join, sep } from 'node:path';
import type { RequestHandler } from 'express';
import { injectFullOverlay } from './inject';
import { proxyRequest } from './proxy';
import type { PreviewRegistry } from './registry';

const HTML_EXT = /\.html?$/i;

function contentTypeFor(file: string): string {
  if (HTML_EXT.test(file)) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

/**
 * Serve `/review/:projectId/*`. Static previews serve instrumented files from
 * the workspace (injecting the per-page overlay config into HTML). Framework
 * previews are reverse-proxied to their loopback dev server.
 */
export function createReviewMiddleware(previews: PreviewRegistry): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const match = /^\/([^/]+)(\/.*)?$/.exec(req.path);
      if (!match) {
        next();
        return;
      }
      const projectId = match[1];
      const rest = match[2] ?? '/';
      const session = previews.get(projectId);
      if (!session) {
        res.status(404).send('Unknown or expired review link.');
        return;
      }

      if (session.mode === 'proxy') {
        proxyRequest(session, rest, req, res, next);
        return;
      }

      // Static serving.
      const siteDir = session.siteDir;
      if (!siteDir) {
        res.status(500).send('preview site directory is missing');
        return;
      }
      let relative = decodeURIComponent(rest).replace(/^\/+/, '');
      if (relative === '' || relative.endsWith('/')) {
        relative += session.project.htmlEntry ?? 'index.html';
      }
      const abs = normalize(join(siteDir, relative));
      // Prevent path traversal out of the served directory.
      if (abs !== siteDir && !abs.startsWith(siteDir + sep)) {
        res.status(403).send('forbidden');
        return;
      }
      if (!existsSync(abs)) {
        res.status(404).send('not found');
        return;
      }

      const type = contentTypeFor(abs);
      if (HTML_EXT.test(abs)) {
        const html = await readFile(abs, 'utf8');
        // Static HTML is no longer instrumented, so inject the full overlay
        // (css + config + bundle) at serve time rather than just the config.
        const injected = injectFullOverlay(html, {
          projectId,
          reviewKey: session.project.baseCommit,
          route: rest,
        });
        res.type(type).send(injected);
      } else {
        res.type(type).send(await readFile(abs));
      }
    })().catch(next);
  };
}
