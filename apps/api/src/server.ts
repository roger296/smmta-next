import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { closeDatabase } from './config/database.js';
import {
  startReservationExpiryLoop,
  stopReservationExpiryLoop,
} from './modules/storefront/reservation.service.js';

async function main() {
  const env = getEnv();
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`SMMTA-Next API running at http://${env.HOST}:${env.PORT}`);
    app.log.info(`API docs at http://${env.HOST}:${env.PORT}/docs`);

    // v1: in-process polling loop. TODO: migrate to a BullMQ worker on
    // the existing Redis instance once we add a dedicated worker process.
    startReservationExpiryLoop();
    app.log.info('Reservation expiry loop started (60s interval)');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    stopReservationExpiryLoop();
    await app.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
