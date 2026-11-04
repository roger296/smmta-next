/**
 * Worker handlers for the email system's jobs. Installed by
 * installFeatureHandlers; each is idempotent so a retry or an overlapping
 * run does no harm.
 */
import type { Logger } from 'pino';
import { setHandler } from '../../../worker/handlers.js';
import { processQueue } from '../services/sender.service.js';
import { BackInStockService } from '../services/back-in-stock.service.js';
import { VerificationService } from '../services/verification.service.js';
import { BouncerError } from '../lib/bouncer.js';
import { eventPayload } from './event-payload.js';

export function installEmailHandlers(logger: Logger): void {
  const log = logger.child({ module: 'email' });
  const bis = new BackInStockService();

  setHandler('email-send', async () => {
    const res = await processQueue();
    if (res.refused) log.warn({ refused: res.refused }, 'email sender refused to run: EMAIL_SEND_MODE is not set');
    else if (res.sent > 0) log.info({ sent: res.sent }, 'email sends processed');
  });

  const verification = new VerificationService();
  setHandler('email-verify', async (data) => {
    const payload = await eventPayload<{ contactId?: string; source?: string }>(data);
    if (!payload?.contactId) return;
    try {
      const out = await verification.verifyContact(payload.contactId, { source: payload.source });
      if (out.status === 'verified') log.info({ result: out.result }, 'contact verified');
    } catch (err) {
      // Retryable errors go back to pg-boss (3 retries, backing off); a
      // permanent one (bad key) is logged and dropped.
      if (err instanceof BouncerError && !err.retryable) {
        log.error({ err: err.message }, 'Bouncer verification failed permanently');
        return;
      }
      throw err;
    }
  });

  setHandler('email-verify-retry', async () => {
    const n = await verification.retryUnknown();
    if (n) log.info({ retried: n }, 'unknown Bouncer results re-checked');
  });

  setHandler('email-bis-recheck', async () => {
    const n = await bis.recheckOpenRequests();
    log.info({ queued: n }, 'back-in-stock re-check');
  });

  setHandler('email-close-stale-bis', async () => {
    const n = await bis.closeStale();
    log.info({ closed: n }, 'stale back-in-stock requests closed');
  });
}
