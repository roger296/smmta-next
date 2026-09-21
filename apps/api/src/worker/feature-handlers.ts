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
import { SubscriptionService } from '../modules/subscriptions/subscription.service.js';
import { DigestService } from '../modules/digest/digest.service.js';
import { ShippingLabelService } from '../modules/shipping/shipping-label.service.js';
import { labelWantedFor } from '../modules/shipping/label-trigger.js';
import { PickNoteNotFoundError, PickNoteService } from '../modules/shipping/pick-note.service.js';
import { DispatchEmailRejectedError, sendDispatchEmail } from '../modules/shipping/dispatch-email.js';
import { orderHasWarehouseLines, queueSupplierOrders } from '../modules/suppliers/supplier-order-routing.js';
import {
  buildGoogleFeed,
  feedPathFor,
  parseFeedShops,
  type FeedMode,
} from '../modules/catalogue/google-feed.service.js';
import { getEnv } from '../config/env.js';
import { getSingletonCompanyId } from '../shared/auth/company.js';

export function installFeatureHandlers(logger: Logger): void {
  const interest = new InterestFlagService();
  const preorders = new PreorderService();
  const compose = new ComposeService();
  const send = new SendService();
  const approval = new ApprovalQueueService();
  const notify = new NotificationService();
  const marketing = new MarketingService();
  const subs = new SubscriptionService();
  const digest = new DigestService();
  const shippingLabels = new ShippingLabelService();
  const pickNotes = new PickNoteService();

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

  // agent-digest (Prompt 15, §6): assemble + log the owner digest. The email
  // send goes through the transactional pipeline once a recipient is wired.
  setHandler('agent-digest', async () => {
    logger.info({ digest: await digest.buildDigest() }, 'agent-digest ran');
  });

  // Marketing agent (Prompt 12): nightly cadence recompute + segmentation.
  setHandler('run-out-prediction', async () => {
    logger.info({ written: await marketing.recomputePredictions() }, 'run-out-prediction ran');
  });
  setHandler('marketing-nightly', async () => {
    logger.info(await marketing.runNightly(), 'marketing-nightly ran');
  });

  // Subscriptions (Prompt 13): renewal charges + dunning retries.
  setHandler('subscription-renewal-scan', async () => {
    const renewals = await subs.renewalScan();
    const dunning = await subs.paymentRetry();
    logger.info({ ...renewals, ...dunning }, 'subscription-renewal-scan ran');
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

  // create-shipping-label: buy and store a Smooth Parcel label for a paid
  // storefront order, or for any fully allocated order when
  // SHIPPING_LABEL_ON_ALLOCATION is on. Idempotent, so the retry policy can
  // never buy a second label, and an order that is paid and then allocated
  // gets one label, not two. Pre-order payments also emit order.paid but ship
  // later, so of those only events tagged source: 'storefront' are acted on
  // (see labelWantedFor).
  setHandler('create-shipping-label', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ eventType: domainEvents.eventType, payload: domainEvents.payload, companyId: domainEvents.companyId })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const payload = event?.payload as { orderId?: string; source?: string } | undefined;
    if (!event || !payload?.orderId) return;
    if (!labelWantedFor(event.eventType, payload.source, getEnv().SHIPPING_LABEL_ON_ALLOCATION)) return;
    // A supplier posts its own lines, so an order with nothing from our
    // warehouse needs no label from us.
    if (!(await orderHasWarehouseLines(payload.orderId))) {
      logger.info({ orderId: payload.orderId }, 'create-shipping-label: no warehouse lines, no label needed');
      return;
    }
    const label = await shippingLabels.requestLabel(payload.orderId, event.companyId);
    logger.info({ orderId: payload.orderId, status: label.status }, 'create-shipping-label ran');
  });

  // create-pick-note: make or refresh the order's pick note. Triggered by
  // order.paid, order.created and order.lines_changed. Unchanged orders are a
  // no-op (the content hash matches), so repeated or retried events are cheap.
  setHandler('create-pick-note', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ payload: domainEvents.payload, companyId: domainEvents.companyId })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const orderId = (event?.payload as { orderId?: string } | undefined)?.orderId;
    if (!event || !orderId) return;
    try {
      const note = await pickNotes.generate(orderId, event.companyId);
      logger.info({ orderId, status: note.status }, 'create-pick-note ran');
    } catch (err) {
      // A deleted order will never have a pick note; retrying cannot help.
      if (err instanceof PickNoteNotFoundError) {
        logger.warn({ orderId }, 'create-pick-note: order not found');
        return;
      }
      throw err;
    }
  });

  // create-supplier-orders: queue one supplier order per supplier shipping
  // part of a paid order. Idempotent per (order, supplier), so a replayed
  // event queues nothing new. The placer loop sends them.
  setHandler('create-supplier-orders', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ payload: domainEvents.payload, companyId: domainEvents.companyId })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const orderId = (event?.payload as { orderId?: string } | undefined)?.orderId;
    if (!event || !orderId) return;
    const result = await queueSupplierOrders(orderId, event.companyId);
    if (result.supplierIds.length > 0) logger.info({ orderId, ...result }, 'create-supplier-orders ran');
  });

  // send-dispatch-email: tell the customer their order has shipped, with the
  // courier and tracking number. Triggered by order.dispatched.
  setHandler('send-dispatch-email', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    const [event] = await getDb()
      .select({ payload: domainEvents.payload, companyId: domainEvents.companyId })
      .from(domainEvents)
      .where(eq(domainEvents.id, eventId))
      .limit(1);
    const orderId = (event?.payload as { orderId?: string } | undefined)?.orderId;
    if (!event || !orderId) return;
    try {
      const outcome = await sendDispatchEmail(orderId, event.companyId);
      logger.info({ orderId, outcome }, 'send-dispatch-email ran');
    } catch (err) {
      // The storefront refused this request; sending it again cannot help.
      if (err instanceof DispatchEmailRejectedError) {
        logger.error({ orderId, status: err.status, body: err.body }, 'send-dispatch-email: storefront refused the email');
        return;
      }
      throw err;
    }
  });

  // Google Merchant Centre feeds, written where the API serves them so Google
  // can fetch on its own schedule: the whole catalogue nightly, then price and
  // availability hourly, because Google suspends accounts whose feed disagrees
  // with the shop and a full Ralawise stock sweep takes about 7 hours. Off
  // unless GOOGLE_FEED_ENABLED is set.
  const buildFeeds = async (mode: FeedMode): Promise<void> => {
    const env = getEnv();
    if (!env.GOOGLE_FEED_ENABLED) {
      logger.debug({ mode }, 'google feed skipped: GOOGLE_FEED_ENABLED is false');
      return;
    }
    const shops = parseFeedShops(env.GOOGLE_FEED_SHOPS);
    if (shops.length === 0) {
      logger.warn({ mode }, 'google feed: GOOGLE_FEED_SHOPS is empty, so nothing was built');
      return;
    }
    const companyId = getSingletonCompanyId();
    for (const shop of shops) {
      try {
        const summary = await buildGoogleFeed({
          companyId,
          mode,
          channelSlug: shop.channelSlug,
          baseUrl: shop.baseUrl,
          outPath: feedPathFor(env.GOOGLE_FEED_DIR, shop.channelSlug, mode),
          defaultShippingGbp: env.GOOGLE_FEED_DEFAULT_SHIPPING_GBP,
        });
        logger.info(summary, 'google feed written');
      } catch (err) {
        // One shop's failure must not cost the other shop its feed.
        logger.error(
          { mode, channelSlug: shop.channelSlug, err: err instanceof Error ? err.message : String(err) },
          'google feed failed for a shop',
        );
      }
    }
  };

  setHandler('google-feed-build', () => buildFeeds('full'));
  setHandler('google-feed-stock-build', () => buildFeeds('stock'));
}
