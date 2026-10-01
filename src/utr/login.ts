import type { Page } from 'playwright';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';
import { drawEditorUrl, siteOrigin } from './event.ts';

const CREDENTIAL_FIELDS = [
  'input[type="email"]', 'input[type="password"]',
  'input[autocomplete="username"]', 'input[autocomplete="current-password"]',
  'input[name*="email" i]', 'input[name*="password" i]'
] as const;

export function loginTimeout(value = process.env.UTR_LOGIN_TIMEOUT_MS): number {
  const parsed = Number(value || 600_000);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : 600_000;
}

async function authenticationState(page: Page): Promise<'authenticated'|'login'|'unknown'> {
  if (await firstVisible(page, SELECTORS.authenticated)) return 'authenticated';
  if (await firstVisible(page, SELECTORS.login)) return 'login';
  const pathname = new URL(page.url()).pathname.toLocaleLowerCase();
  if (/\/(login|signin|sign-in|auth)(\/|$)/.test(pathname)) return 'login';
  // The UTR home page does not consistently render an account-menu marker even
  // for a valid saved session. The draw editor is access-controlled, so its own
  // visible controls are reliable positive evidence after login checks above.
  if (/\/events\/\d+\/draws\/?$/.test(pathname)) {
    const editor = page.getByText(/^Match #\d+/).first();
    const rounds = page.getByText(/^(Round of 16|Quarterfinals|Semifinals|Final)/i).first();
    if (await editor.isVisible().catch(() => false) || await rounds.isVisible().catch(() => false)) return 'authenticated';
  }
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
  let existing = await authenticatedPage(page.context().pages());
  if (existing) return existing;
  // A persisted UTR session can look anonymous on the site root. Probe the
  // configured, access-controlled draw editor before asking the user to log in
  // again; this avoids a false login prompt for an already authenticated Mac.
  const editorUrl = drawEditorUrl();
  if (editorUrl) {
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await Promise.race([
      page.getByText(/^Match #\d+/).first().waitFor({ state: 'visible', timeout: 10_000 }),
      page.locator('input[type="email"], input[type="password"], [data-testid="modal.login-popup.overlay"]').first().waitFor({ state: 'visible', timeout: 10_000 })
    ]).catch(() => undefined);
    existing = await authenticatedPage(page.context().pages());
    if (existing) return existing;
  }
  await screenshot(page, 'authentication-required');
  if (process.env.UTR_HEADLESS?.toLocaleLowerCase() === 'true') {
    console.error('Authentication was not detected in headless mode. Run once with UTR_HEADLESS=false to complete login/MFA.');
    return undefined;
  }
  // Never click a Sign in / Log in button. UTR uses the same text for both the
  // control that opens its form and the form submit button; distinguishing them
  // unreliably can submit empty fields before the user has a chance to type.
  const credentialForm = await firstVisible(page, CREDENTIAL_FIELDS);
  if (credentialForm) {
    console.log('UTR login form is ready in the browser. Enter your credentials there; the tool will not submit the form for you.');
    await credentialForm.locator.focus().catch(() => undefined);
  } else {
    const loginControl = await firstVisible(page, SELECTORS.loginAction);
    console.log(loginControl
      ? `UTR sign-in control is ready (${loginControl.selector}). Click it yourself, then enter and submit your credentials.`
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
