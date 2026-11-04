/**
 * The two public pages in a real browser at 375 px with JavaScript off:
 * no horizontal scroll, the button reachable, and the forms work. Requests
 * are routed into the Fastify app with inject, so no server is needed.
 *
 * Needs a Chromium build (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or the one this
 * environment ships at /opt/pw-browsers/chromium). Where neither exists — the
 * API's CI job installs no browser — the block is skipped, not failed.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../app.js';
import { ContactsService } from '../services/contacts.service.js';
import { makeContact } from '../testing.js';
import { publicPageLimiter } from './public.routes.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/opt/pw-browsers/chromium';
const haveBrowser = existsSync(executablePath);

describe.skipIf(!haveBrowser)('public pages in a browser (375 px, JavaScript off)', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  const ORIGIN = 'http://shop.test';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  async function page() {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, javaScriptEnabled: false });
    const p = await ctx.newPage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await p.route('**/*', async (route: any) => {
      const req = route.request();
      const url = new URL(req.url());
      const res = await app.inject({
        method: req.method(),
        url: url.pathname + url.search,
        headers: req.headers(),
        payload: req.postData() ?? undefined,
      });
      await route.fulfill({ status: res.statusCode, headers: res.headers as Record<string, string>, body: res.body });
    });
    return p;
  }

  async function noHorizontalScroll(p: { evaluate: (f: () => number) => Promise<number> }) {
    const width = await p.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  }

  it('unsubscribe: fits, the button is reachable, and it works without JavaScript', async () => {
    publicPageLimiter.reset();
    const c = await makeContact({ initialStatus: 'all' });
    const p = await page();
    await p.goto(`${ORIGIN}/email/u/${c.unsubscribeToken}`);
    await noHorizontalScroll(p);
    const button = p.getByRole('button', { name: 'Unsubscribe' });
    await expect(button.isVisible()).resolves.toBe(true);
    await button.click();
    await p.waitForSelector('text=You are unsubscribed');
    expect((await new ContactsService().get(c.id))!.marketingStatus).toBe('transactional_only');
    await noHorizontalScroll(p);
  });

  it('preferences: fits and saves without JavaScript', async () => {
    publicPageLimiter.reset();
    const c = await makeContact({ initialStatus: 'all' });
    const p = await page();
    await p.goto(`${ORIGIN}/email/preferences/${c.unsubscribeToken}`);
    await noHorizontalScroll(p);
    await p.getByLabel('PETG').check();
    await p.getByRole('button', { name: 'Save preferences' }).click();
    await p.waitForSelector('text=Saved.');
    const after = await new ContactsService().get(c.id);
    expect(Object.keys(after!.interests)).toContain('material:petg');
  });
});
