/**
 * SendGrid wrapper (SPEC §4.6). Interface-first so tests inject a fake.
 * Transactional vs marketing sender identities are chosen by `category`
 * (order confirmations must never share reputation with promotions). Sandbox
 * mode is enforced during the build — no real delivery. Postgres is the single
 * source of truth for who is contactable; SendGrid is a dumb pipe.
 */
import { getEnv } from '../../config/env.js';

export type MailCategory = 'transactional' | 'marketing';

export interface SendMailInput {
  to: string;
  category: MailCategory;
  subject: string;
  html: string;
  /** Idempotency key (= draft id) — the wrapper must not double-send it. */
  idempotencyKey: string;
  /** One-click unsubscribe URL (marketing only) → List-Unsubscribe header. */
  unsubscribeUrl?: string;
}

export interface SendMailResult {
  messageId: string;
  sandboxed: boolean;
}

export interface SendGridPort {
  send(input: SendMailInput): Promise<SendMailResult>;
}

/** In-memory fake: records sends, dedupes by idempotency key. */
export class FakeSendGrid implements SendGridPort {
  public sent: SendMailInput[] = [];
  private seen = new Map<string, SendMailResult>();

  async send(input: SendMailInput): Promise<SendMailResult> {
    const existing = this.seen.get(input.idempotencyKey);
    if (existing) return existing;
    const result = { messageId: `sg_fake_${this.seen.size + 1}`, sandboxed: true };
    this.seen.set(input.idempotencyKey, result);
    this.sent.push(input);
    return result;
  }

  reset(): void {
    this.sent = [];
    this.seen.clear();
  }
}

/** Real client — sandbox unless NODE_ENV=production && !SENDGRID_SANDBOX. */
export class SendGridClient implements SendGridPort {
  private apiKey: string;
  private sandbox: boolean;

  constructor() {
    const env = getEnv();
    this.apiKey = env.SENDGRID_API_KEY;
    this.sandbox = env.SENDGRID_SANDBOX || env.NODE_ENV !== 'production';
  }

  private from(category: MailCategory): string {
    const env = getEnv();
    return category === 'marketing' ? env.SENDGRID_FROM_MARKETING : env.SENDGRID_FROM_TRANSACTIONAL;
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    const body = {
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: this.from(input.category) },
      subject: input.subject,
      content: [{ type: 'text/html', value: input.html }],
      headers: input.unsubscribeUrl
        ? { 'List-Unsubscribe': `<${input.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : undefined,
      mail_settings: { sandbox_mode: { enable: this.sandbox } },
    };
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`SendGrid send failed: ${res.status}`);
    }
    return { messageId: res.headers.get('x-message-id') ?? `sg_${Date.now()}`, sandboxed: this.sandbox };
  }
}

let _sg: SendGridPort | undefined;
export function getSendGrid(): SendGridPort {
  if (!_sg) {
    const env = getEnv();
    _sg = env.NODE_ENV === 'test' || !env.SENDGRID_API_KEY ? new FakeSendGrid() : new SendGridClient();
  }
  return _sg;
}
export function setSendGridForTests(port: SendGridPort): void {
  _sg = port;
}
export function resetSendGridForTests(): void {
  _sg = undefined;
}
