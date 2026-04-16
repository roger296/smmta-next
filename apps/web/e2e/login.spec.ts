import { expect, test } from '@playwright/test';
import { getOrGenerateToken } from './helpers/auth';

test('unauthenticated visit to / redirects to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
});

test('pasting a valid token signs in and lands on dashboard', async ({ page }) => {
  const token = getOrGenerateToken();
  await page.goto('/login');
  await page.getByLabel(/jwt token/i).fill(token);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  await expect(page.getByRole('navigation', { name: /main navigation/i })).toBeVisible();
});

test('invalid token string shows validation error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/jwt token/i).fill('not-a-jwt');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('alert')).toContainText(/not.+jwt/i);
  await expect(page).toHaveURL(/\/login$/);
});
