import { expect, test } from '@playwright/test';
import { authenticatePage } from './helpers/auth';

test('authenticated user sees empty-state on customers list', async ({ page }) => {
  await authenticatePage(page);
  await page.goto('/customers');
  await expect(page.getByRole('heading', { name: /customers/i })).toBeVisible();
  await expect(page.getByText(/no customers yet/i)).toBeVisible();
});
