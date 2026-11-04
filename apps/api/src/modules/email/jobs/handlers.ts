/**
 * Worker handlers for the email system's jobs. Installed by
 * installFeatureHandlers; each is idempotent so a retry or an overlapping
 * run does no harm.
 */
import type { Logger } from 'pino';
import { setHandler } from '../../../worker/handlers.js';
import { processQueue } from '../services/sender.service.js';
import { BackInStockService } from '../services/back-in-stock.service.js';

export function installEmailHandlers(logger: Logger): void {
  const log = logger.child({ module: 'email' });
  const bis = new BackInStockService();

  setHandler('email-send', async () => {
    const res = await processQueue();
    if (res.refused) log.warn({ refused: res.refused }, 'email sender refused to run: EMAIL_SEND_MODE is not set');
    else if (res.sent > 0) log.info({ sent: res.sent }, 'email sends processed');
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
