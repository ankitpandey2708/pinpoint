import { spawn, type ChildProcess } from 'node:child_process';

export interface Tunnel {
  /** Public https origin, e.g. https://abc-def.trycloudflare.com */
  url: string;
  /** Terminate the tunnel process. */
  stop: () => Promise<void>;
}

export interface TunnelOptions {
  /** Per-attempt time to wait for the public URL. Default 30s. */
  timeoutMs?: number;
  /** Total attempts before giving up. Default 2 (i.e. one retry). */
  attempts?: number;
  /** Delay between attempts. Default 2s. */
  retryDelayMs?: number;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One spawn attempt: resolve on the first announced URL, reject on early exit. */
function attemptTunnel(targetUrl: string, timeoutMs: number): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('cloudflared', ['tunnel', '--url', targetUrl], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;

    const stop = (): Promise<void> =>
      new Promise<void>((res) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          res();
          return;
        }
        child.once('exit', () => res());
        child.kill();
      });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stop();
      reject(new Error('cloudflared did not report a public URL in time'));
    }, timeoutMs);

    // cloudflared prints the URL on stderr; watch both streams to be safe.
    const onData = (buf: Buffer): void => {
      const match = URL_RE.exec(buf.toString());
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[0], stop });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    // spawn errors (e.g. cloudflared not on PATH) surface here.
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited (code ${code ?? 'unknown'}) before providing a URL`));
    });
  });
}

/**
 * Start a Cloudflare quick tunnel to a local origin and resolve once the public
 * URL is announced. Account-less quick tunnels occasionally fail to provision
 * (transient exit 1), so a failed attempt is retried with a short backoff before
 * giving up. The CLI treats a final failure as non-fatal and keeps serving on
 * local URLs.
 */
export async function startTunnel(targetUrl: string, opts: TunnelOptions = {}): Promise<Tunnel> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const attempts = Math.max(1, opts.attempts ?? 2);
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await attemptTunnel(targetUrl, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // eslint-disable-next-line no-await-in-loop
        await delay(retryDelayMs);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
