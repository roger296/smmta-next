/**
 * HTTP sender for back-in-stock notifications.
 *
 * The actual email rendering + SendGrid call lives in the storefront
 * (`apps/store/app/api/internal/send-back-in-stock/route.ts`). This
 * thin wrapper posts the payload at that route, authenticated with
 * `STORE_INTERNAL_API_KEY` (matches the storefront's `ADMIN_API_KEY`,
 * which is also what `process-outbox` accepts).
 *
 * Failure throws — the caller (`NotifyMeService.fulfilForProduct`)
 * uses the throw as the signal to leave the row pending so a future
 * trigger can retry.
 */
import { getEnv } from '../../config/env.js';
import type { NotifyMeSender, NotifyMeSendPayload } from './notify-me.service.js';

export class HttpNotifyMeSender implements NotifyMeSender {
  async send(payload: NotifyMeSendPayload): Promise<void> {
    const env = getEnv();
    if (!env.STORE_BASE_URL || !env.STORE_INTERNAL_API_KEY) {
      throw new Error(
        'STORE_BASE_URL / STORE_INTERNAL_API_KEY not configured — cannot dispatch back-in-stock email',
      );
    }
    const url = `${env.STORE_BASE_URL.replace(/\/$/, '')}/api/internal/send-back-in-stock`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.STORE_INTERNAL_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`back-in-stock send failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Test/dev sender that records calls instead of making HTTP requests.
 * Used by the GRN trigger tests so we don't have to spin up the
 * storefront just to assert "yes, a send was attempted".
 */
export class InMemoryNotifyMeSender implements NotifyMeSender {
  public readonly sent: NotifyMeSendPayload[] = [];
  public failNext = false;

  async send(payload: NotifyMeSendPayload): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated send failure');
    }
    this.sent.push(payload);
  }
}
