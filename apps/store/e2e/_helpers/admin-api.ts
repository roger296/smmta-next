/**
 * Helpers for hitting the SMMTA-NEXT admin / storefront API directly
 * from inside Playwright tests — to seed catalogue data, look up an
 * order's status after the storefront committed it, etc.
 *
 * The Playwright tests don't drive `apps/web` (the operator SPA);
 * they hit the API surface that SPA would call. That keeps tests
 * fast and decoupled from the admin UI.
 */
import { request } from '@playwright/test';

export interface SeedResult {
  groupSlug: string;
  productId: string;
  productSlug: string;
}

/** Resolve the API base URL from env, with a sensible local default. */
export function apiBaseUrl(): string {
  return (process.env.SMMTA_API_BASE_URL ?? 'http://localhost:8080/api/v1').replace(
    /\/$/,
    '',
  );
}

export async function getStorefrontGroup(slug: string): Promise<unknown | null> {
  const ctx = await request.newContext();
  const res = await ctx.get(`${apiBaseUrl()}/storefront/groups/${slug}`);
  await ctx.dispose();
  if (res.status() === 404) return null;
  if (!res.ok()) throw new Error(`getStorefrontGroup ${slug}: ${res.status()}`);
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? null;
}

/** GET /storefront/orders/:id — the public order projection used by
 *  the customer track page. We use it in e2e to assert that a checkout
 *  actually committed an order. */
export async function getPublicOrder(
  orderId: string,
): Promise<{ id: string; status: string } | null> {
  const ctx = await request.newContext();
  const res = await ctx.get(`${apiBaseUrl()}/storefront/orders/${orderId}`);
  await ctx.dispose();
  if (res.status() === 404) return null;
  if (!res.ok()) throw new Error(`getPublicOrder ${orderId}: ${res.status()}`);
  const body = (await res.json()) as { data?: { id: string; status: string } };
  return body.data ?? null;
}
