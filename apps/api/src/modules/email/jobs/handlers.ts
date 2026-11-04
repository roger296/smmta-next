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
import { MaintenanceService } from '../services/maintenance.service.js';
import { AttributionService } from '../services/attribution.service.js';
import { ContactsService } from '../services/contacts.service.js';
import { getEmailSettings } from '../services/settings.service.js';
import { CampaignsService } from '../services/campaigns.service.js';
import { DigestService, reached } from '../services/digest.service.js';
import '../services/ab.service.js';
import { checkDns } from '../services/dns.service.js';

export function installEmailHandlers(logger: Logger): void {
  const log = logger.child({ module: 'email' });
  const bis = new BackInStockService();

  setHandler('email-send', async () => {
    const res = await processQueue();
    if (res.refused) log.warn({ refused: res.refused }, 'email sender refused to run: EMAIL_SEND_MODE is not set');
    else if (res.sent + res.dropped + res.retried > 0) log.info(res, 'email sends processed');
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

  const maintenance = new MaintenanceService();
  const attribution = new AttributionService();

  setHandler('email-order-placed', async (data) => {
    const payload = await eventPayload<{ orderId?: string }>(data);
    if (payload?.orderId) await attribution.processOrder(payload.orderId);
  });

  setHandler('email-reconcile-suppressions', async () => {
    const r = await maintenance.reconcileSuppressions();
    log.info(r, 'SendGrid suppressions reconciled');
  });

  setHandler('email-deliverability-check', async () => {
    const r = await maintenance.deliverabilityCheck();
    if (r.paused) log.error({ rates: r.rates }, 'marketing email paused itself');
  });

  setHandler('email-decay-interests', async () => {
    const s = await getEmailSettings();
    const n = await new ContactsService().decayInterests(new Date(), {
      halfLifeDays: s.interest_decay.half_life_days,
      orderPoints: s.interest_decay.order_points,
      clickPoints: s.interest_decay.click_points,
      threshold: s.interest_decay.interested_threshold,
    });
    log.info({ contacts: n }, 'interest scores decayed');
  });

  setHandler('email-prune-events', async () => {
    log.info({ deleted: await maintenance.pruneEvents() }, 'old email events pruned');
  });

  const campaigns = new CampaignsService();
  const digest = new DigestService();
  setHandler('email-campaigns-tick', async () => {
    const r = await campaigns.tick();
    if (r.expanded || r.finished || r.decided) log.info(r, 'campaigns ticked');
  });
  setHandler('email-digest-draft', async () => {
    const s = await getEmailSettings();
    const now = new Date();
    if (!reached(now, s.digest.draft_day, s.digest.draft_time)) return;
    const c = await digest.createWeeklyDigest(now);
    log.info({ campaignId: c.id, status: c.status, audience: c.audienceCount }, 'weekly digest ready');
  });
  setHandler('email-new-product-rollup', async () => {
    const s = await getEmailSettings();
    const now = new Date();
    if (!reached(now, null, s.new_product_rollup_time)) return;
    const c = await digest.createNewProductRollup(now);
    if (c) log.info({ campaignId: c.id }, 'new-product roll-up ready');
  });

  setHandler('email-dns-check', async () => {
    const checks = await checkDns();
    const failing = checks.filter((c) => !c.ok).map((c) => c.record);
    if (failing.length) log.warn({ failing }, 'email DNS check: records missing');
  });

  setHandler('email-close-stale-bis', async () => {
    const n = await bis.closeStale();
    log.info({ closed: n }, 'stale back-in-stock requests closed');
  });
}
