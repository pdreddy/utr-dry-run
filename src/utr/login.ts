import type { Page } from 'playwright';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';

export function loginTimeout(value = process.env.UTR_LOGIN_TIMEOUT_MS): number {
  const parsed = Number(value || 600_000);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : 600_000;
}

async function authenticationState(page: Page): Promise<'authenticated'|'login'|'unknown'> {
  if (await firstVisible(page, SELECTORS.authenticated)) return 'authenticated';
  if (await firstVisible(page, SELECTORS.login)) return 'login';
  const pathname = new URL(page.url()).pathname.toLocaleLowerCase();
  if (/\/(login|signin|sign-in|auth)(\/|$)/.test(pathname)) return 'login';
  return 'unknown';
}

export async function ensureAuthenticated(page: Page): Promise<boolean> {
  await page.goto('https://app.utrsports.net/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  if (await authenticationState(page) === 'authenticated') return true;
  await screenshot(page, 'authentication-required');
  if (process.env.UTR_HEADLESS?.toLocaleLowerCase() === 'true') {
    console.error('Authentication was not detected in headless mode. Run once with UTR_HEADLESS=false to complete login/MFA.');
    return false;
  }
  const timeout = loginTimeout();
  console.log(`UTR login required. Complete login/MFA in the open browser; waiting up to ${Math.round(timeout / 60_000)} minutes...`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await authenticationState(page) === 'authenticated') {
      await screenshot(page, 'authentication-confirmed');
      return true;
    }
    await page.waitForTimeout(1_000);
  }
  await screenshot(page, 'authentication-timeout');
  return false;
}
