import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';

export interface UtrSession { context: BrowserContext; page: Page }

export async function openSession(): Promise<UtrSession> {
  const { chromium } = await import('playwright');
  const profile = path.resolve(process.env.UTR_PROFILE_DIR || '.playwright/utr-profile');
  fs.mkdirSync(profile, { recursive: true });
  const channel = process.env.UTR_BROWSER_CHANNEL || undefined;
  const headless = process.env.UTR_HEADLESS === 'true' || !process.env.DISPLAY;
  const context = await chromium.launchPersistentContext(profile, {
    headless, channel, viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page };
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
