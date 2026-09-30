import type { Page } from 'playwright';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';

export async function ensureAuthenticated(page: Page): Promise<boolean> {
  await page.goto('https://app.utrsports.net/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  if (await firstVisible(page, SELECTORS.authenticated)) return true;
  await screenshot(page, 'authentication-required');
  if (process.env.UTR_HEADLESS === 'true' || !process.env.DISPLAY) return false;
  console.log('UTR login required. Complete login/MFA in the browser; waiting up to 5 minutes...');
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (await firstVisible(page, SELECTORS.authenticated)) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}
