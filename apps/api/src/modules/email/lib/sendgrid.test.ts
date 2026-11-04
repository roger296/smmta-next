import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPayload, SendGridError, SendGridTransport, type OutgoingEmail } from './sendgrid.js';

const base: OutgoingEmail = {
  to: 'someone@example.com',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  sendId: '00000000-0000-4000-8000-000000000001',
  campaignId: null,
  contactId: '00000000-0000-4000-8000-000000000002',
  class: 'requested_service',
  kind: 'back_in_stock',
  fromName: 'CleverDeals',
  fromAddress: 'sales@cleverdeals.net',
  replyTo: 'sales@cleverdeals.net',
};

afterEach(() => vi.unstubAllGlobals());

describe('buildPayload', () => {
  it('a transactional send: custom args, categories, no unsubscribe headers, tracking, sandbox', () => {
    expect(buildPayload(base, 'sandbox')).toMatchInlineSnapshot(`
      {
        "categories": [
          "transactional",
          "requested_service",
          "back_in_stock",
        ],
        "content": [
          {
            "type": "text/plain",
            "value": "Hi",
          },
          {
            "type": "text/html",
            "value": "<p>Hi</p>",
          },
        ],
        "from": {
          "email": "sales@cleverdeals.net",
          "name": "CleverDeals",
        },
        "mail_settings": {
          "sandbox_mode": {
            "enable": true,
          },
        },
        "personalizations": [
          {
            "custom_args": {
              "campaign_id": "",
              "class": "requested_service",
              "contact_id": "00000000-0000-4000-8000-000000000002",
              "kind": "back_in_stock",
              "send_id": "00000000-0000-4000-8000-000000000001",
            },
            "to": [
              {
                "email": "someone@example.com",
              },
            ],
          },
        ],
        "reply_to": {
          "email": "sales@cleverdeals.net",
        },
        "subject": "Hello",
        "tracking_settings": {
          "click_tracking": {
            "enable": true,
            "enable_text": false,
          },
          "open_tracking": {
            "enable": true,
          },
          "subscription_tracking": {
            "enable": false,
          },
        },
      }
    `);
  });

  it('a marketing send carries the unsubscribe headers and the marketing category', () => {
    const p = buildPayload(
      {
        ...base,
        class: 'marketing',
        kind: 'weekly_digest',
        campaignId: 'c1',
        headers: { 'List-Unsubscribe': '<https://x/email/u/t>, <mailto:u@x?subject=t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      },
      'live',
    ) as Record<string, any>;
    expect(p.categories).toEqual(['marketing', 'weekly_digest']);
    expect(p.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(p.personalizations[0].custom_args.campaign_id).toBe('c1');
    expect(p.mail_settings.sandbox_mode.enable).toBe(false);
    expect(p.tracking_settings.subscription_tracking.enable).toBe(false);
  });

  it('sandbox only in sandbox mode', () => {
    expect((buildPayload(base, 'allowlist') as any).mail_settings.sandbox_mode.enable).toBe(false);
    expect((buildPayload(base, 'sandbox') as any).mail_settings.sandbox_mode.enable).toBe(true);
  });
});

describe('SendGridTransport', () => {
  it('returns the message id and classifies failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202, headers: { 'x-message-id': 'abc' } })));
    expect(await new SendGridTransport('key').send({})).toEqual({ messageId: 'abc' });
    for (const [status, retryable] of [[429, true], [503, true], [400, false], [403, false]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errors":[{"message":"nope"}]}', { status })));
      const err = await new SendGridTransport('key').send({}).catch((e) => e);
      expect(err).toBeInstanceOf(SendGridError);
      expect(err.retryable).toBe(retryable);
      expect(err.body).toContain('nope');
    }
  });
});
