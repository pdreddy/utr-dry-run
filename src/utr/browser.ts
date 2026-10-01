import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';

export interface UtrSession { context: BrowserContext; page: Page; externallyManaged: boolean; close(): Promise<void> }

export function shouldRunHeadless(value = process.env.UTR_HEADLESS): boolean {
  return value?.trim().toLocaleLowerCase() === 'true';
}

export function validatedCdpUrl(value = process.env.UTR_CDP_URL): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error('UTR_CDP_URL must point to Chrome on localhost');
  }
  return url.toString();
}

export async function openSession(): Promise<UtrSession> {
  const { chromium } = await import('playwright');
  const cdp = validatedCdpUrl();
  if (cdp) {
    const browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Connected Chrome has no browser context');
    const existing = context.pages().find(candidate => candidate.url().includes('app.utrsports.net'));
    const page = existing ?? await context.newPage();
    // This Chrome process belongs to the user. Never close its default context
    // or pages; ending this Node process drops the CDP transport naturally.
    return { context, page, externallyManaged: true, close: async () => undefined };
  }
  const profile = path.resolve(process.env.UTR_PROFILE_DIR || '.playwright/utr-profile');
  fs.mkdirSync(profile, { recursive: true });
  const channel = process.env.UTR_BROWSER_CHANNEL || undefined;
  // Do not infer headless mode from DISPLAY: macOS and Windows normally have no
  // DISPLAY variable, and doing so prevents the user from completing login/MFA.
  const headless = shouldRunHeadless();
  const context = await chromium.launchPersistentContext(profile, {
    headless, channel, viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page, externallyManaged: false, close: () => context.close() };
}

export async function screenshot(page: Page, name: string): Promise<string> {
  const dir = process.env.UTR_SCREENSHOT_DIR || 'screenshots';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name.replace(/[^a-z0-9_.-]/gi, '_')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

export async function firstVisible(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) return { selector, locator: candidate };
  }
  return undefined;
}
