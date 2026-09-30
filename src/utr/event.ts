import type { Page } from 'playwright';
import { screenshot } from './browser.ts';

export function eventUrl(): string | undefined {
  if (process.env.UTR_EVENT_URL) return process.env.UTR_EVENT_URL;
  if (process.env.UTR_EVENT_ID) return `https://app.utrsports.net/events/${encodeURIComponent(process.env.UTR_EVENT_ID)}`;
}

export async function openAndVerifyEvent(page: Page, live: boolean): Promise<{ verified: boolean; name: string }> {
  const url = eventUrl();
  if (!url) throw new Error('Set UTR_EVENT_URL or UTR_EVENT_ID');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const heading = page.getByRole('heading').first();
  const name = (await heading.textContent().catch(() => ''))?.trim() || (await page.title());
  const expected = process.env.UTR_EVENT_NAME?.trim();
  const verified = Boolean(expected && name.toLocaleLowerCase().includes(expected.toLocaleLowerCase()));
  await screenshot(page, 'event-discovery');
  if (live && !verified) throw new Error('Live mode requires UTR_EVENT_NAME to exactly identify the target event page');
  return { verified, name };
}
