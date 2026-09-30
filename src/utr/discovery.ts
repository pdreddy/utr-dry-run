import fs from 'node:fs';
import type { Page } from 'playwright';
import { SELECTORS } from './selectors.ts';

export async function discoverControls(page: Page, file = 'logs/utr-selector-report.json'): Promise<Record<string, string[]>> {
  const report: Record<string, string[]> = {};
  for (const [name, candidates] of Object.entries(SELECTORS)) {
    report[name] = [];
    for (const selector of candidates) if (await page.locator(selector).count().catch(() => 0)) report[name]!.push(selector);
  }
  fs.mkdirSync('logs', { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ url: page.url(), title: await page.title(), controls: report }, null, 2));
  return report;
}
