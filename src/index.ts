#!/usr/bin/env node
import { buildProgram, startReview, realServices, type RunningReview } from './cli/review';

/** CLI entry point: `pinpoint review <repo> [--port] [--host]`. */
async function main(): Promise<void> {
  let running: RunningReview | undefined;

  const program = buildProgram(async (opts) => {
    running = await startReview(opts, realServices(process.cwd()));
    // eslint-disable-next-line no-console
    console.log(`\n  Pin Point is ready.\n`);
    // eslint-disable-next-line no-console
    console.log(`  Review link (send to your client): ${running.reviewUrl}`);
    // eslint-disable-next-line no-console
    console.log(`  Developer dashboard:                ${running.dashboardUrl}`);
    if (opts.host && opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      // eslint-disable-next-line no-console
      console.log(`\n  Sharing on ${opts.host}. localhost is local-only; use a LAN IP or tunnel for remote clients.`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`\n  localhost is local-only. Use --host 0.0.0.0 for LAN, or a tunnel for remote clients.`);
    }
    // eslint-disable-next-line no-console
    console.log(`\n  Press Ctrl+C to stop.\n`);
  });

  const shutdown = async (): Promise<void> => {
    if (running) {
      // eslint-disable-next-line no-console
      console.log('\n  Shutting down…');
      await running.close();
    }
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
