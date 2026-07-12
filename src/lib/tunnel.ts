import { spawn, type ChildProcess } from 'node:child_process';

export interface Tunnel {
  /** Public https origin, e.g. https://abc-def.trycloudflare.com */
  url: string;
  /** Terminate the tunnel process. */
  stop: () => Promise<void>;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Start a Cloudflare quick tunnel to a local origin and resolve once the public
 * URL is announced. Rejects if `cloudflared` is not installed or no URL appears
 * before the timeout. The caller decides whether a failure is fatal — the CLI
 * treats it as non-fatal and falls back to local-only URLs.
 */
export function startTunnel(targetUrl: string, opts: { timeoutMs?: number } = {}): Promise<Tunnel> {
  const timeoutMs = opts.timeoutMs ?? 30000;
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

    // spawn errors (e.g. cloudflared not on PATH) surface here on Windows/POSIX.
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
