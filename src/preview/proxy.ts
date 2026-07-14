import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request, Response, NextFunction } from 'express';
import { injectFullOverlay, type OverlayContext } from './inject';
import type { PreviewRegistry, PreviewSession } from './registry';

const proxy = httpProxy.createProxyServer({ selfHandleResponse: true, ws: true });

// Force identity encoding so we can rewrite HTML bodies reliably.
proxy.on('proxyReq', (proxyReq) => {
  proxyReq.setHeader('accept-encoding', 'identity');
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ctx = (req as IncomingMessage & { __pinpoint?: OverlayContext }).__pinpoint;
  const contentType = String(proxyRes.headers['content-type'] ?? '');
  const serverRes = res as ServerResponse;

  if (ctx && contentType.includes('text/html')) {
    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = injectFullOverlay(Buffer.concat(chunks).toString('utf8'), ctx);
      const headers = { ...proxyRes.headers };
      delete headers['content-length'];
      delete headers['content-encoding'];
      serverRes.writeHead(proxyRes.statusCode ?? 200, headers as Record<string, string>);
      serverRes.end(body);
    });
    return;
  }

  serverRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers as Record<string, string>);
  proxyRes.pipe(serverRes);
});

proxy.on('error', (_err, _req, res) => {
  const serverRes = res as ServerResponse | undefined;
  if (serverRes && !serverRes.headersSent) {
    serverRes.writeHead(502, { 'content-type': 'text/plain' });
    serverRes.end('preview upstream error');
  }
});

/** Proxy an HTTP request for a framework preview to its loopback dev server. */
export function proxyRequest(
  session: PreviewSession,
  route: string,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!session.proxyUrl) {
    next(new Error('proxy session has no upstream url'));
    return;
  }
  (req as Request & { __pinpoint?: OverlayContext }).__pinpoint = {
    projectId: session.project.id,
    reviewKey: session.project.baseCommit,
    route,
  };
  req.url = route;
  proxy.web(req, res, { target: session.proxyUrl }, (err) => next(err));
}

/**
 * Handle a WebSocket upgrade for a `/review/:projectId/*` connection by
 * proxying it to the matching framework dev server. Returns false when the URL
 * is not a proxied review socket so the caller can ignore it.
 */
export function handleUpgrade(
  previews: PreviewRegistry,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const match = /^\/review\/([^/]+)(\/.*)?$/.exec(req.url ?? '');
  if (!match) return false;
  const session = previews.get(match[1]);
  if (!session || session.mode !== 'proxy' || !session.proxyUrl) return false;
  req.url = match[2] ?? '/';
  proxy.ws(req, socket, head, { target: session.proxyUrl });
  return true;
}
