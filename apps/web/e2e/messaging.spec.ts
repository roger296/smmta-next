/**
 * Messaging (docs/email, runbook section 11), against a running API in
 * sandbox mode with EMAIL_TEST_ALLOWLIST=owner@example.com:
 * a manual campaign to a three-contact segment (preview, test send,
 * schedule), a status change with a reason, an import dry run, and the
 * marketing pause switch refusing marketing.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { authenticatePage, getOrGenerateToken } from './helpers/auth';

// @ts-expect-error - Node global, available at runtime in Playwright
const API: string = process.env.E2E_API_URL ?? 'http://localhost:8080/api/v1';
const run = Date.now().toString(36);

async function api(request: APIRequestContext, method: 'post' | 'patch' | 'put', path: string, data: unknown) {
  const res = await request[method](`${API}${path}`, { data, headers: { authorization: `Bearer ${getOrGenerateToken()}` } });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
  return (await res.json()).data;
}

test('a manual campaign, a status change, an import dry run and the pause switch', async ({ page, request }) => {
  await authenticatePage(page);
  const emails = [1, 2, 3].map((i) => `e2e-${run}-${i}@example.com`);
  const ids: string[] = [];
  for (const email of emails) {
    const r = await api(request, 'post', '/email/contacts/record-consent', { email, source: 'e2e', evidence: 'playwright fixture' });
    ids.push(r.contactId);
  }

  // Campaign: create in the UI, narrow the segment to the three contacts.
  await page.goto('/messaging/campaigns');
  await expect(page.getByTestId('send-mode-banner')).toContainText(/Sandbox mode/);
  await page.getByRole('button', { name: 'New campaign' }).click();
  await expect(page).toHaveURL(/\/messaging\/campaigns\/[0-9a-f-]{36}$/);
  const campaignId = page.url().split('/').pop()!;
  await api(request, 'patch', `/email/campaigns/${campaignId}`, { segment: { contact_ids: ids } });
  await page.reload();
  await page.getByLabel('Subject', { exact: true }).fill(`E2E ${run}`);
  await page.getByRole('button', { name: '+ Text' }).click();
  await page.getByLabel('Text').fill('Hello from the end-to-end test.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByTestId('segment-count')).toContainText('3 contacts');

  await page.getByRole('button', { name: 'Show preview' }).click();
  await expect(page.getByRole('button', { name: 'with interests' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'trade' })).toBeVisible();
  await expect(page.getByText(`Subject: E2E ${run}`)).toBeVisible();

  await page.getByLabel('Test address').fill('owner@example.com');
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(/SendGrid delivers nothing/)).toBeVisible();

  await page.getByRole('button', { name: 'Schedule' }).click();
  await expect(page.locator('text=scheduled').first()).toBeVisible();
  await page.goto('/messaging/campaigns');
  await expect(page.getByRole('link', { name: /^New campaign/ }).first()).toBeVisible();

  // A status change with a reason shows up as a consent event.
  await page.goto(`/messaging/contacts/${ids[0]}`);
  await page.getByLabel('New status').selectOption('transactional_only');
  await page.getByLabel('Reason').fill('asked by phone in the e2e test');
  await page.getByRole('button', { name: 'Change status' }).click();
  await expect(page.getByText(/all → transactional_only · admin_ui/)).toBeVisible();

  // An import dry run from the Imports page.
  await page.goto('/messaging/imports');
  await page.getByLabel('List type').selectOption('unsubscribes');
  await page.getByLabel('CSV file').setInputFiles({
    name: 'unsubs.csv',
    mimeType: 'text/csv',
    // @ts-expect-error - Node global, available at runtime in Playwright
    buffer: Buffer.from(`email\n${emails[1]}\n`),
  });
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByTestId('import-report')).toContainText('would downgrade: 1');

  // The pause switch: marketing is refused while paused.
  await page.goto('/messaging/deliverability');
  await page.getByLabel('Pause reason').fill('e2e test');
  await page.getByRole('button', { name: 'Pause marketing' }).click();
  await expect(page.getByTestId('send-mode-banner')).toContainText('Marketing is paused');
  const other = await api(request, 'post', '/email/campaigns', { name: `Paused ${run}`, subject: 'x', segment: { contact_ids: ids } });
  await page.goto(`/messaging/campaigns/${other.id}`);
  await expect(page.getByTestId('segment-count')).toContainText('0 contacts');
  await page.goto('/messaging/deliverability');
  await page.getByRole('button', { name: 'Resume marketing' }).click();
  await expect(page.getByTestId('send-mode-banner')).not.toContainText('Marketing is paused');
});

test('every Messaging page loads', async ({ page }) => {
  await authenticatePage(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['campaigns', 'contacts', 'imports', 'automations', 'templates', 'deliverability', 'settings']) {
    await page.goto(`/messaging/${path}`);
    await expect(page.getByRole('heading', { name: 'Messaging' })).toBeVisible();
    await expect(page.getByTestId('send-mode-banner')).toBeVisible();
    await expect(page.getByText(/Something went wrong|Request failed/)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
