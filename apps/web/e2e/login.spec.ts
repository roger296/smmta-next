/**
 * Desktop email + password sign-in.
 *
 * Rewritten during the Aug-2026 feedback set: these specs were written against
 * a login page that took a **pasted JWT**, which the app replaced with real
 * `POST /auth/login` credentials some time ago. All three failed on the
 * untouched `autostock` branch — a pre-existing red that only surfaced when F1
 * started running Playwright as a gate. Fixed here, and nothing else changed
 * about them.
 */
import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';

test('unauthenticated visit to / redirects to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
});

test('the sign-in form asks for email and password', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
});

test('wrong credentials show an error and stay on /login', async ({ page }) => {
  await page.route('**/api/v1/auth/login', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'invalid_credentials' }),
    }),
  );

  await page.goto('/login');
  await page.getByLabel(/email/i).fill('nobody@example.invalid');
  await page.getByLabel(/password/i).fill('wrong-password');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
  await expect(page).toHaveURL(/\/login$/);
});

test('an existing token lands on the dashboard, not the login page', async ({ page }) => {
  await authenticatePage(page);
  await page.goto('/');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('complementary', { name: /main navigation/i })).toBeVisible();
});
