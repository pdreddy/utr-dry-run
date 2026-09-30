import type { Page } from 'playwright';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';

export function loginTimeout(value = process.env.UTR_LOGIN_TIMEOUT_MS): number {
  const parsed = Number(value || 600_000);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : 600_000;
}

async function hasAuthenticationStorage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const names = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
    return names.some(name => /(auth|token|session|user)/i.test(name));
  }).catch(() => false);
}

async function hasAuthenticationCookie(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies().catch(() => []);
  return cookies.some(cookie => /(auth|token|session|jwt)/i.test(cookie.name) && Boolean(cookie.value));
}

async function authenticationState(page: Page): Promise<'authenticated'|'login'|'unknown'> {
  if (await firstVisible(page, SELECTORS.authenticated)) return 'authenticated';
  if (await firstVisible(page, SELECTORS.login)) return 'login';
  const pathname = new URL(page.url()).pathname.toLocaleLowerCase();
  if (/\/(login|signin|sign-in|auth)(\/|$)/.test(pathname)) return 'login';
  if (await hasAuthenticationStorage(page) || await hasAuthenticationCookie(page)) return 'authenticated';
  // UTR may remove the profile control at narrow breakpoints. An internal app
  // route with a visible main region and no login control is a final safe signal.
  if (pathname !== '/' && await page.getByRole('main').isVisible().catch(() => false)) return 'authenticated';
  return 'unknown';
}

async function authenticatedPage(pages: Page[]): Promise<Page | undefined> {
  for (const candidate of [...pages].reverse()) {
    if (candidate.isClosed()) continue;
    if (await authenticationState(candidate) === 'authenticated') return candidate;
  }
}

export async function ensureAuthenticated(page: Page): Promise<Page | undefined> {
  await page.goto('https://app.utrsports.net/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const existing = await authenticatedPage(page.context().pages());
  if (existing) return existing;
  await screenshot(page, 'authentication-required');
  if (process.env.UTR_HEADLESS?.toLocaleLowerCase() === 'true') {
    console.error('Authentication was not detected in headless mode. Run once with UTR_HEADLESS=false to complete login/MFA.');
    return undefined;
  }
  const loginControl = await firstVisible(page, SELECTORS.login);
  if (loginControl) {
    console.log(`Opening UTR login using discovered control: ${loginControl.selector}`);
    await loginControl.locator.click().catch(() => undefined);
  } else {
    console.log('No login button was detected. Use the open browser to navigate to Log in / Sign in.');
  }
  const timeout = loginTimeout();
  console.log(`UTR login required. Complete login/MFA in the open browser; waiting up to ${Math.round(timeout / 60_000)} minutes...`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const active = await authenticatedPage(page.context().pages());
    if (active) {
      await screenshot(active, 'authentication-confirmed');
      return active;
    }
    await page.waitForTimeout(1_000);
  }
  await screenshot(page, 'authentication-timeout');
  return undefined;
}
