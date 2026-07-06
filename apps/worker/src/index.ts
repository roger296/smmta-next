/**
 * @smmta/worker — the background-job process (SPEC §4.1).
 *
 * A deliberately thin bootstrap: load env, start the worker, trap signals.
 * All job/dispatcher/event logic lives in @smmta/api's `worker` module so it
 * shares one Drizzle schema + typecheck unit with the API (see BUILD_LOG
 * entry 1). In production this runs as its own systemd unit; if the LLM
 * composition jobs ever contend with web traffic it can move to a second VPS
 * without touching the API (SPEC §6 scale-out).
 */
import { createServer } from 'node:http';
import { startWorker, initSentry, checkHealth } from '@smmta/api/worker';

// Load environment from the worker's own .env, falling back to the API's, so a
// dev run needs no exported vars. In production systemd supplies the env via
// EnvironmentFile and both loads are simply skipped.
function loadEnv(): void {
  const load = (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (!load) return;
  for (const path of ['.env', '../api/.env']) {
    try {
      load(path);
      return;
    } catch {
      // try next candidate
    }
  }
}

/** Optional health server for monitoring/systemd (WORKER_HEALTH_PORT > 0). */
function startHealthServer(): ReturnType<typeof createServer> | undefined {
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 0);
  if (!port) return undefined;
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      void checkHealth().then((h) => {
        res.writeHead(h.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(h));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port);
  return server;
}

async function main(): Promise<void> {
  loadEnv();
  initSentry('worker');
  const health = startHealthServer();
  const handle = await startWorker();

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    handle.logger.info({ sig }, 'worker: signal received, shutting down');
    health?.close();
    await handle.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('worker: fatal on startup', err);
  process.exit(1);
});
