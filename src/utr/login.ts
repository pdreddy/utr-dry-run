import type { Page } from 'playwright';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';
import { siteOrigin } from './event.ts';

export function loginTimeout(value = process.env.UTR_LOGIN_TIMEOUT_MS): number {
  const parsed = Number(value || 600_000);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : 600_000;
}

async function authenticationState(page: Page): Promise<'authenticated'|'login'|'unknown'> {
  if (await firstVisible(page, SELECTORS.authenticated)) return 'authenticated';
  if (await firstVisible(page, SELECTORS.login)) return 'login';
  const pathname = new URL(page.url()).pathname.toLocaleLowerCase();
  if (/\/(login|signin|sign-in|auth)(\/|$)/.test(pathname)) return 'login';
  // Do not infer authentication from generic cookies/storage: analytics state
  // exists for signed-out visitors and previously caused the browser to flash
  // open, be treated as logged in, and immediately close on the next error.
  // Do not treat a generic internal page or a Home/Profile link as proof of a
  // session. Signed-out UTR pages render both and can otherwise skip the login
  // form without ever giving the account owner a chance to enter credentials.
  return 'unknown';
}

async function authenticatedPage(pages: Page[]): Promise<Page | undefined> {
  for (const candidate of [...pages].reverse()) {
    if (candidate.isClosed()) continue;
    if (await authenticationState(candidate) === 'authenticated') return candidate;
  }
}

export async function ensureAuthenticated(page: Page): Promise<Page | undefined> {
  try {
    await page.goto(siteOrigin(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    throw new Error(`Could not load ${siteOrigin()} (${(error as Error).message.split('\n')[0]}). Check your internet/VPN/proxy, or try UTR_BROWSER_CHANNEL=chrome in .env to use installed Google Chrome.`);
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  // The root is a client-rendered app. Let its session check render either the
  // account menu or login control before deciding that neither is present.
  await page.waitForTimeout(1_500);
  const existing = await authenticatedPage(page.context().pages());
  if (existing) return existing;
  await screenshot(page, 'authentication-required');
  if (process.env.UTR_HEADLESS?.toLocaleLowerCase() === 'true') {
    console.error('Authentication was not detected in headless mode. Run once with UTR_HEADLESS=false to complete login/MFA.');
    return undefined;
  }
  const loginControl = await firstVisible(page, SELECTORS.loginAction);
  if (loginControl) {
    console.log(`Opening UTR login using discovered control: ${loginControl.selector}`);
    await loginControl.locator.click().catch(error => {
      console.log(`Could not click the login control automatically (${(error as Error).message.split('\n')[0]}). Click it in the open browser.`);
    });
  } else {
    const formVisible = Boolean(await firstVisible(page, ['input[type="email"]', 'input[type="password"]']));
    console.log(formVisible
      ? 'UTR login form is ready in the browser. Enter your credentials there; the tool does not read or store them.'
      : 'No login button was detected. Use the open browser to navigate to Log in / Sign in.');
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
