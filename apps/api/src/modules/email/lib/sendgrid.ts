/**
 * The only code in the email system that talks to SendGrid's Mail Send API
 * (spec § Sending pipeline). `buildPayload` is pure, so the exact JSON can be
 * tested; `SendGridTransport` posts it.
 *
 *  - custom_args come back on every webhook event: send_id, campaign_id,
 *    contact_id, class, kind.
 *  - categories: the two-way split (transactional / marketing) plus the class
 *    and kind, so SendGrid's own stats separate them.
 *  - List-Unsubscribe headers on marketing only.
 *  - click + open tracking on, subscription tracking OFF: this system owns
 *    unsubscribes.
 *  - sandbox mode on unless EMAIL_SEND_MODE is allowlist or live.
 */
import type { EmailClass } from '../../../db/schema/index.js';
import { getEnv } from '../../../config/env.js';
import { broadCategory } from './gate.js';
import type { SendMode } from './config.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  sendId: string;
  campaignId: string | null;
  contactId: string;
  class: EmailClass;
  kind: string;
  /** Extra headers (List-Unsubscribe for marketing). */
  headers?: Record<string, string>;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

export function buildPayload(msg: OutgoingEmail, mode: SendMode): Record<string, unknown> {
  return {
    personalizations: [
      {
        to: [{ email: msg.to }],
        custom_args: {
          send_id: msg.sendId,
          campaign_id: msg.campaignId ?? '',
          contact_id: msg.contactId,
          class: msg.class,
          kind: msg.kind,
        },
      },
    ],
    from: { email: msg.fromAddress, name: msg.fromName },
    reply_to: { email: msg.replyTo },
    subject: msg.subject,
    content: [
      { type: 'text/plain', value: msg.text },
      { type: 'text/html', value: msg.html },
    ],
    categories: [...new Set([broadCategory(msg.class), msg.class, msg.kind])].map((c) => c.slice(0, 255)),
    ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      subscription_tracking: { enable: false },
    },
    mail_settings: { sandbox_mode: { enable: mode === 'sandbox' } },
  };
}

export class SendGridError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** 429 and 5xx (and network failures) are worth retrying. */
    public readonly retryable: boolean,
    public readonly body: string,
  ) {
    super(message);
  }
}

export interface EmailTransport {
  send(payload: Record<string, unknown>): Promise<{ messageId: string }>;
}

export class SendGridTransport implements EmailTransport {
  constructor(
    private readonly apiKey = getEnv().SENDGRID_API_KEY,
    private readonly url = 'https://api.sendgrid.com/v3/mail/send',
  ) {}

  async send(payload: Record<string, unknown>): Promise<{ messageId: string }> {
    if (!this.apiKey) throw new SendGridError('SENDGRID_API_KEY is not set', 0, false, '');
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new SendGridError(`SendGrid unreachable: ${err instanceof Error ? err.name : 'error'}`, 0, true, '');
    }
    if (res.status === 200 || res.status === 202) {
      // Sandbox mode returns 200 with no message id.
      return { messageId: res.headers.get('x-message-id') ?? `sandbox-${Date.now().toString(36)}` };
    }
    const body = (await res.text().catch(() => '')).slice(0, 2000);
    throw new SendGridError(`SendGrid ${res.status}`, res.status, res.status === 429 || res.status >= 500, body);
  }
}
