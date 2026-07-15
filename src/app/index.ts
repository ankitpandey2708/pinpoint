#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildProgram, startReview, realConfig, type RunningReview } from './cli';
import { startTunnel, type Tunnel } from '../platform/tunnel';
import { killAllSessions } from '../preview/cleanup';

/* eslint-disable no-console */

/** CLI entry point: `pinpoint [repo]` (review a repo, defaults to cwd) or `pinpoint kill`. */
async function main(): Promise<void> {
  let running: RunningReview | undefined;
  let tunnel: Tunnel | undefined;

  const program = buildProgram(async (opts) => {
    // Pinpoint's own data (projects db, logs) lives in one stable per-user dir,
    // not the working directory — so a globally-installed `pinpoint` run from any
    // folder shares one store instead of scattering `data/` wherever it is invoked.
    running = await startReview(opts, realConfig(join(homedir(), '.pinpoint')));
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
  }, async () => {
    const killed = await killAllSessions();
    console.log(
      killed > 0
        ? `\n  Killed ${killed} Pinpoint process(es); cleared workspaces.\n`
        : `\n  No live Pinpoint sessions; cleared workspaces.\n`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    // Guard against re-entry: several termination signals can arrive together
    // (e.g. Ctrl+C then terminal close), and each reap must run to completion
    // exactly once before we exit.
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Shutting down…');
    if (tunnel) await tunnel.stop().catch(() => undefined);
    if (running) await running.close().catch(() => undefined);
    process.exit(0);
  };
  // Reap on every termination signal we can catch so the dev-server tree is not
  // orphaned however the session ends: SIGINT = Ctrl+C, SIGTERM = kill,
  // SIGHUP = terminal/console close. SIGBREAK (Ctrl+Break) exists only on
  // Windows and throws if listened for on POSIX, so it is added conditionally.
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const sig of signals) process.on(sig, () => void shutdown());

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
