import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { screenshot } from './browser.ts';

export interface UtrConfig { eventUrl?: string; eventId?: string; eventName?: string }

export function readUtrConfig(file = process.env.UTR_CONFIG || 'utr.config.json'): UtrConfig {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return {};
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8')) as UtrConfig;
  return parsed;
}

export function eventUrl(config = readUtrConfig()): string | undefined {
  const configured = process.env.UTR_EVENT_URL || config.eventUrl;
  const id = process.env.UTR_EVENT_ID || config.eventId;
  const value = configured || (id ? `https://app.utrsports.net/events/${encodeURIComponent(id)}` : undefined);
  if (!value) return undefined;
  const url = new URL(value);
  // A loopback host is permitted so the full flow can be rehearsed against the
  // local mock (tests/mock-utr); it can never reach a real event.
  const utr = url.protocol === 'https:' && url.hostname === 'app.utrsports.net';
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!(utr || loopback) || !/^\/events\/\d+\/?$/.test(url.pathname)) {
    throw new Error('UTR event URL must be an https://app.utrsports.net/events/<numeric-id> URL');
  }
  return url.toString();
}

/** Site root used for the authentication check (UTR, or the local mock). */
export function siteOrigin(): string {
  const url = eventUrl();
  return url ? `${new URL(url).origin}/` : 'https://app.utrsports.net/';
}

export async function openAndVerifyEvent(page: Page, live: boolean): Promise<{ verified: boolean; name: string }> {
  const url = eventUrl();
  if (!url) throw new Error('Set UTR_EVENT_URL or UTR_EVENT_ID');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const heading = page.getByRole('heading').first();
  const name = (await heading.textContent().catch(() => ''))?.trim() || (await page.title());
  const expected = (process.env.UTR_EVENT_NAME || readUtrConfig().eventName)?.trim();
  const verified = Boolean(expected && name.toLocaleLowerCase().includes(expected.toLocaleLowerCase()));
  await screenshot(page, 'event-discovery');
  if (live && !verified) throw new Error('Live mode requires UTR_EVENT_NAME to exactly identify the target event page');
  return { verified, name };
}
