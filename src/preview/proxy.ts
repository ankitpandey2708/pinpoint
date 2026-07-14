import { createProxyServer } from 'http-proxy-3';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { injectFullOverlay, type OverlayContext } from './inject';
import type { PreviewRegistry, PreviewSession } from './registry';

const proxy = createProxyServer({ selfHandleResponse: true, ws: true });

/**
 * The upstream host to advertise in rewritten Host/Origin/Referer headers.
 * A framework dev server (Next.js) trusts only its own dev host — `localhost` —
 * when applying its cross-origin protection to dev resources (`/_next/*`, HMR,
 * RSC). We connect over the target's loopback IP, but must claim `localhost`
 * here: a `127.0.0.1` origin is treated as cross-origin and the dev resources
 * are blocked, which stops the client hydrating and leaves the preview showing
 * only server-rendered chrome with no interactive content. Port is preserved.
 */
function sameOriginHost(target: string | { href?: string } | undefined): string | undefined {
  if (!target) return undefined;
  try {
    const url = new URL(typeof target === 'string' ? target : (target.href ?? ''));
    return url.port ? `localhost:${url.port}` : 'localhost';
  } catch {
    return undefined;
  }
}

// Force identity encoding so we can rewrite HTML bodies reliably, and rewrite
// the Host/Origin/Referer so the framework dev server treats proxied requests
// as same-origin (see sameOriginHost).
proxy.on('proxyReq', (proxyReq, _req, _res, options) => {
  proxyReq.setHeader('accept-encoding', 'identity');
  const host = sameOriginHost((options as { target?: string | { href?: string } } | undefined)?.target);
  if (!host) return;
  proxyReq.setHeader('host', host);
  if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', `http://${host}`);
  if (proxyReq.getHeader('referer')) proxyReq.setHeader('referer', `http://${host}/`);
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
  // `res` is an HTTP ServerResponse for a web request, but a raw socket for a
  // WebSocket upgrade error — which has no writeHead. Guard so a failed upgrade
  // (e.g. the upstream HMR socket) closes the socket instead of crashing the
  // whole server.
  if (res && typeof (res as ServerResponse).writeHead === 'function') {
    const serverRes = res as ServerResponse;
    if (!serverRes.headersSent) {
      serverRes.writeHead(502, { 'content-type': 'text/plain' });
      serverRes.end('preview upstream error');
    }
  } else if (res && typeof (res as Duplex).destroy === 'function') {
    (res as Duplex).destroy();
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
 * Resolve which proxy-mode preview a root-absolute request belongs to. A
 * proxied framework app emits root-absolute asset URLs (`/_next/*`, fonts,
 * `/manifest.webmanifest`) that the browser requests at the origin root, outside
 * the `/review/:projectId` prefix. We recover the project from the `Referer`
 * (the review page that triggered the request); failing that, if exactly one
 * proxy session is active we use it.
 */
export function resolveProxySession(
  previews: PreviewRegistry,
  req: { get(name: string): string | undefined },
): PreviewSession | undefined {
  const referer = req.get('referer') ?? req.get('referrer');
  if (referer) {
    try {
      const match = /^\/review\/([^/]+)/.exec(new URL(referer).pathname);
      if (match) {
        const session = previews.get(match[1]);
        if (session && session.mode === 'proxy' && session.proxyUrl) return session;
      }
    } catch {
      /* malformed referer: fall through to the single-session heuristic */
    }
  }
  const active = previews.list().filter((s) => s.mode === 'proxy' && s.proxyUrl);
  return active.length === 1 ? active[0] : undefined;
}

/**
 * Express handler that forwards root-absolute asset requests a proxied framework
 * app makes (e.g. `/_next/*`) to the matching preview's dev server. Mounted as
 * the final fallback so it only sees paths no earlier route claimed.
 */
export function proxyAssetFallback(previews: PreviewRegistry): RequestHandler {
  return (req, res, next) => {
    const session = resolveProxySession(previews, req);
    if (!session) {
      next();
      return;
    }
    proxyRequest(session, req.originalUrl, req, res, next);
  };
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
  let session: PreviewSession | undefined;
  let path: string;
  if (match) {
    session = previews.get(match[1]);
    path = match[2] ?? '/';
  } else {
    // Root-level socket (e.g. Next HMR at /_next/webpack-hmr): resolve the
    // active proxy session the same way the asset fallback does.
    session = resolveProxySession(previews, {
      get: (name) => {
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      },
    });
    path = req.url ?? '/';
  }
  if (!session || session.mode !== 'proxy' || !session.proxyUrl) return false;
  req.url = path;
  // Same-origin rewrite so the dev server's cross-origin protection accepts the
  // upgrade (matches the HTTP proxyReq rewrite above).
  const host = sameOriginHost(session.proxyUrl);
  if (host) {
    req.headers.host = host;
    if (req.headers.origin) req.headers.origin = `http://${host}`;
  }
  proxy.ws(req, socket, head, { target: session.proxyUrl });
  return true;
}
