import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { screenshot } from './browser.ts';

/**
 * Writes a structural snapshot of the page the account owner is looking at:
 * roles, labels, class names and short text of interactive controls and of the
 * elements that look like match cards. No cookies, tokens, storage or headers.
 */
export async function inspectPage(page: Page, name: string, dir = process.env.UTR_LOG_DIR || 'logs'): Promise<string> {
  const snapshot = await page.evaluate(() => {
    const clip = (value: string | null | undefined, n = 80) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const describe = (el: Element) => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? undefined, type: el.getAttribute('type') ?? undefined,
      id: el.id || undefined, name: el.getAttribute('name') ?? undefined, testid: el.getAttribute('data-testid') ?? undefined,
      ariaLabel: el.getAttribute('aria-label') ?? undefined, ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
      class: clip(el.getAttribute('class'), 100) || undefined, text: clip(el.textContent), selected: el.getAttribute('aria-selected') ?? undefined
    });
    const pick = (selector: string, limit = 80) => [...document.querySelectorAll(selector)].slice(0, limit).map(describe);
    const cards = [...document.querySelectorAll('div, li, article, section')].filter(el => {
      const text = el.textContent ?? '';
      return /Completed|Scheduled|In Progress|Upcoming/i.test(text) && text.length < 400 && el.querySelectorAll('div, li, article, section').length < 25 &&
        ![...el.children].some(child => /Completed|Scheduled|In Progress|Upcoming/i.test(child.textContent ?? '') && (child.textContent ?? '').length > 60 && child.children.length > 4);
    }).slice(0, 6);
    return {
      url: location.href, title: document.title,
      headings: pick('h1,h2,h3,h4'),
      tabs: pick('[role="tab"], [role="tablist"] a, [role="tablist"] button'),
      buttons: pick('button, [role="button"]'),
      links: pick('a[href]', 60),
      comboboxes: pick('select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"]'),
      options: pick('option, [role="option"], [role="menuitem"]'),
      inputs: pick('input, textarea'),
      dialogs: pick('[role="dialog"], [aria-modal="true"]'),
      menuTriggers: pick('[aria-label*="more" i], [aria-label*="menu" i], [aria-label*="option" i], [aria-label*="action" i]'),
      matchCardCandidates: cards.map(el => ({ ...describe(el), html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 1500) }))
    };
  });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `utr-inspect-${name.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  await screenshot(page, `inspect-${name}`);
  return file;
}
