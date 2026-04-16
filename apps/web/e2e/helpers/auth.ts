import { execSync } from 'node:child_process';
import type { Page } from '@playwright/test';

let cachedToken: string | null = null;

/**
 * Generates a real test token by invoking the API's generate-test-token.ts.
 * Cached per process.
 */
export function getOrGenerateToken(): string {
  if (cachedToken) return cachedToken;
  const out = execSync('npx tsx generate-test-token.ts', {
    cwd: '../api',
    encoding: 'utf8',
  });
  const match = out.match(/=== TEST JWT TOKEN ===\s*\n(\S+)/);
  if (!match) throw new Error('Could not parse token from generate-test-token output:\n' + out);
  cachedToken = match[1]!;
  return cachedToken;
}

/**
 * Seeds localStorage with a valid JWT before page scripts run.
 */
export async function authenticatePage(page: Page, token?: string) {
  const t = token ?? getOrGenerateToken();
  await page.addInitScript((jwt) => {
    window.localStorage.setItem('smmta_token', jwt);
  }, t);
}
