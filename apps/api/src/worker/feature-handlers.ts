/**
 * Real event-handler implementations, registered at worker boot BEFORE the
 * Prompt-1 stubs (which only fill gaps). Each later prompt adds its handler
 * here, replacing the corresponding stub without touching the boot wiring.
 */
import type { Logger } from 'pino';
import { getDb } from '../config/database.js';
import { eq } from 'drizzle-orm';
import { domainEvents } from '../db/schema/index.js';
import { setHandler } from './handlers.js';
import { InterestFlagService } from '../modules/interest/interest.service.js';
import { PreorderService } from '../modules/payments/preorder.service.js';
import { ComposeService, type ComposeInput } from '../modules/messaging/compose.service.js';
import { SendService } from '../modules/messaging/send.service.js';
import { ApprovalQueueService } from '../modules/approval/approval.service.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { MarketingService } from '../modules/marketing/marketing.service.js';

export function installFeatureHandlers(logger: Logger): void {
  const interest = new InterestFlagService();
  const preorders = new PreorderService();
  const compose = new ComposeService();
  const send = new SendService();
  const approval = new ApprovalQueueService();
  const notify = new NotificationService();
  const marketing = new MarketingService();

  // threshold-check (Prompt 7): count flags for a prospective product on
  // interest.flag_created; emit interest.threshold_crossed exactly once.
  setHandler('threshold-check', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    await interest.thresholdCheck(eventId);
    logger.debug({ eventId }, 'threshold-check ran');
  });

  // payment-window-scan (Prompt 6): manual-transfer overdue/lapse sweep.
  setHandler('payment-window-scan', async () => {
    const result = await preorders.scanPaymentWindow();
    logger.info(result, 'payment-window-scan ran');
  });

  // compose-message (Prompt 9): the job data IS the compose input (enqueued by
  // the notification/marketing agents in later prompts).
  setHandler('compose-message', async (data) => {
    await compose.compose(data as ComposeInput);
    logger.debug('compose-message ran');
  });

  // send-message (Prompt 9): triggered by draft.approved — resolve the draft id
  // from the event payload and run the send-time gate.
  setHandler('send-message', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const draftId = (event?.payload as { draftId?: string })?.draftId;
    if (draftId) {
      const outcome = await send.send(draftId);
      logger.info({ draftId, outcome }, 'send-message ran');
    }
  });

  // expired-draft-sweep (Prompt 10, §17.7): expire stale drafts.
  setHandler('expired-draft-sweep', async () => {
    const n = await approval.expiredDraftSweep();
    logger.info({ expired: n }, 'expired-draft-sweep ran');
  });

  // Marketing agent (Prompt 12): nightly cadence recompute + segmentation.
  setHandler('run-out-prediction', async () => {
    logger.info({ written: await marketing.recomputePredictions() }, 'run-out-prediction ran');
  });
  setHandler('marketing-nightly', async () => {
    logger.info(await marketing.runNightly(), 'marketing-nightly ran');
  });

  // ---- Notification agent reactions (Prompt 11, §12.4) ----
  setHandler('back-in-stock-fanout', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (eventId) logger.info({ n: await notify.backInStockFanout(eventId) }, 'back-in-stock-fanout ran');
  });
  setHandler('notify-eta-changed', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (eventId) logger.info({ n: await notify.reactEtaChanged(eventId) }, 'notify-eta-changed ran');
  });
  setHandler('notify-arrival', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    logger.debug({ eventId }, 'notify-arrival ran (window already closed on arrival)');
  });
  setHandler('cancel-user-drafts', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const userId = (event?.payload as { userId?: string })?.userId;
    if (userId) logger.info({ n: await notify.cancelDraftsForUser(userId) }, 'cancel-user-drafts ran');
  });
}
