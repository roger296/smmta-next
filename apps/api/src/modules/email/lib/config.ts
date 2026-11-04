/**
 * Email configuration read from the environment, in one place so the sender,
 * the admin banner and the tests all agree on what mode the system is in.
 */
import { getEnv } from '../../../config/env.js';

export type SendMode = 'sandbox' | 'allowlist' | 'live';

/** The configured send mode, or null when EMAIL_SEND_MODE is unset. The
 *  sender refuses to run on null (runbook D3): nothing is sent until a person
 *  has chosen a mode. */
export function configuredSendMode(): SendMode | null {
  return getEnv().EMAIL_SEND_MODE ?? null;
}

/** The mode to show people: unset reads as sandbox, because nothing is sent. */
export function displaySendMode(): SendMode {
  return configuredSendMode() ?? 'sandbox';
}

export function testAllowlist(): string[] {
  return getEnv()
    .EMAIL_TEST_ALLOWLIST.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowlisted(email: string): boolean {
  return testAllowlist().includes(email.trim().toLowerCase());
}

/** Classes the allowlist holds back in `allowlist` mode. Mail a customer
 *  asked for (back in stock) or needs for an order still reaches everyone,
 *  so testing never leaves real customers without it. */
export function allowlistApplies(cls: string): boolean {
  return cls === 'marketing' || cls === 'service';
}

/** The SendGrid webhook verification key under either name. */
export function webhookVerificationKey(): string {
  const env = getEnv();
  return env.SENDGRID_WEBHOOK_VERIFICATION_KEY || env.SENDGRID_WEBHOOK_PUBLIC_KEY;
}

export function tokenSecret(): string {
  const env = getEnv();
  return env.EMAIL_TOKEN_SECRET || env.UNSUBSCRIBE_SECRET;
}

export function storefrontBaseUrl(): string {
  return getEnv().STOREFRONT_BASE_URL.replace(/\/+$/, '');
}
