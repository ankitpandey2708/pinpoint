#!/usr/bin/env node
import { buildProgram, startReview, realServices, type RunningReview } from './cli/review';
import { startTunnel, type Tunnel } from './lib/tunnel';

/* eslint-disable no-console */

/** CLI entry point: `pinpoint review <repo> [--port] [--host] [--no-tunnel]`. */
async function main(): Promise<void> {
  let running: RunningReview | undefined;
  let tunnel: Tunnel | undefined;

  const program = buildProgram(async (opts) => {
    running = await startReview(opts, realServices(process.cwd()));
    console.log(`\n  Pin Point is ready.\n`);
    console.log(`  Review link (local):    ${running.reviewUrl}`);
    console.log(`  Developer dashboard:    ${running.dashboardUrl}`);

    // A public Cloudflare tunnel is started automatically so the review link is
    // reachable off this machine without a separate tool. Opt out with --no-tunnel.
    // A tunnel failure (e.g. cloudflared not installed) never stops the server.
    if (opts.tunnel !== false) {
      const local = new URL(running.reviewUrl);
      const target = `http://127.0.0.1:${local.port || 80}`;
      try {
        console.log(`\n  Starting public tunnel…`);
        tunnel = await startTunnel(target);
        const publicReview = `${tunnel.url}${local.pathname}`;
        console.log(`  Review link (public):   ${publicReview}`);
        console.log(`\n  Send the PUBLIC link to your client. The dashboard stays local-only.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const notFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
        console.log(`  Tunnel unavailable (${msg}). Continuing with local URLs only.`);
        console.log(
          notFound
            ? `  cloudflared is not on PATH — install it, or pass --no-tunnel.`
            : `  Usually a transient trycloudflare hiccup — just re-run, or pass --no-tunnel.`,
        );
      }
    } else if (opts.host && opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      console.log(`\n  Sharing on ${opts.host}. localhost is local-only; use a LAN IP for remote clients.`);
    } else {
      console.log(`\n  localhost is local-only (--no-tunnel). Use --host 0.0.0.0 for LAN.`);
    }
    console.log(`\n  Press Ctrl+C to stop.\n`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('\n  Shutting down…');
    if (tunnel) await tunnel.stop().catch(() => undefined);
    if (running) await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
