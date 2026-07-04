/**
 * Real event-handler implementations, registered at worker boot BEFORE the
 * Prompt-1 stubs (which only fill gaps). Each later prompt adds its handler
 * here, replacing the corresponding stub without touching the boot wiring.
 */
import type { Logger } from 'pino';
import { setHandler } from './handlers.js';
import { InterestFlagService } from '../modules/interest/interest.service.js';

export function installFeatureHandlers(logger: Logger): void {
  const interest = new InterestFlagService();

  // threshold-check (Prompt 7): count flags for a prospective product on
  // interest.flag_created; emit interest.threshold_crossed exactly once.
  setHandler('threshold-check', async (data) => {
    const { eventId } = (data ?? {}) as { eventId?: string };
    if (!eventId) return;
    await interest.thresholdCheck(eventId);
    logger.debug({ eventId }, 'threshold-check ran');
  });
}
