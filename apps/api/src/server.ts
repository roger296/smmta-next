import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { closeDatabase } from './config/database.js';
import { isLlmConfigured } from './integrations/openrouter/index.js';
import { isEmailDeliverable } from './integrations/sendgrid/sendgrid.js';
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

    // Loud on boot rather than silently broken on the first customer
    // message — a missing key previously fell through to the test
    // double and threw "no scripted turn left" on every chat turn.
    if (!isLlmConfigured()) {
      app.log.warn(
        'OPENROUTER_API_KEY is not set — the storefront chat assistant will refuse every message. Set it in the deploy environment to enable chat.',
      );
    }
    // Same class of problem for mail: without a deliverable config the
    // chat assistant tells customers "someone will be in touch" and the
    // escalation email goes nowhere. Escalation rows record this per
    // send in `email_sent_at`; this makes it visible at boot too.
    if (!isEmailDeliverable()) {
      app.log.warn(
        'SendGrid is not configured for real delivery (missing SENDGRID_API_KEY, SENDGRID_SANDBOX on, or non-production NODE_ENV) — chat escalations will be recorded but no email will reach the sales inbox.',
      );
    }

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
