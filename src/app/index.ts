#!/usr/bin/env node
import { buildProgram, startReview, realServices, type RunningReview } from './cli';
import { startTunnel, type Tunnel } from '../platform/tunnel';

/* eslint-disable no-console */

/** CLI entry point: `pinpoint [repo]`; defaults to the current directory. */
async function main(): Promise<void> {
  let running: RunningReview | undefined;
  let tunnel: Tunnel | undefined;

  const program = buildProgram(async (opts) => {
    running = await startReview(opts, realServices(process.cwd()));
    console.log(`\n  Pin Point is ready.\n`);
    console.log(`  Review link (local):    ${running.reviewUrl}`);
    console.log(`  Developer dashboard:    ${running.dashboardUrl}`);

    // A tunnel failure (for example, cloudflared not being installed) never
    // stops the local review server.
    const local = new URL(running.reviewUrl);
    const target = `http://127.0.0.1:${local.port || 80}`;
    try {
      console.log(`\n  Starting public tunnel…`);
      tunnel = await startTunnel(target);
      // One quick tunnel exposes the whole origin, so both routes are public.
      const dash = new URL(running.dashboardUrl);
      const publicReview = `${tunnel.url}${local.pathname}`;
      const publicDashboard = `${tunnel.url}${dash.pathname}${dash.search}`;
      console.log(`  Review link (public):   ${publicReview}`);
      console.log(`  Dashboard (public):     ${publicDashboard}`);
      console.log(`\n  Send the PUBLIC review link to your client.`);
      console.log(`  The public dashboard is gated ONLY by its token — keep that link private.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      console.log(`  Tunnel unavailable (${msg}). Continuing with local URLs only.`);
      console.log(
        notFound
          ? `  cloudflared is not on PATH — install it to enable public sharing.`
          : `  Usually a transient trycloudflare hiccup — re-run Pin Point to try again.`,
      );
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
