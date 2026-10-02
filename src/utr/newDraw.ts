import fs from 'node:fs';
import type { Locator, Page } from 'playwright';
import { screenshot } from './browser.ts';
import { UtrDrawEditor } from './drawEditor.ts';
import { EDITOR } from './selectors.ts';

/**
 * What to pick on the editor's "Create draw" form. `fields` maps each label exactly as
 * the form shows it to the value to choose (a dropdown option's text, text to type, or
 * true/false for a checkbox), applied in order: put "Draw type" before the fields it reveals.
 */
export interface NewDrawConfig { name: string; division?: string; fields: Record<string, string | boolean> }

export function readDrawConfig(file = process.env.UTR_DRAW_CONFIG || 'draw.json'): NewDrawConfig {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: it lists the new draw's name and what to pick on the "Create draw" form`);
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as NewDrawConfig;
  if (process.env.UTR_NEW_DRAW_NAME) config.name = process.env.UTR_NEW_DRAW_NAME;
  if (!config.name?.trim()) throw new Error(`${file} needs a "name" for the new draw`);
  config.fields ??= {};
  return config;
}

async function click(target: Locator): Promise<void> {
  const label = `${await target.innerText().catch(() => '')} ${await target.getAttribute('aria-label').catch(() => '')}`;
  if (EDITOR.forbiddenClick.test(label)) throw new Error(`Refusing to click "${label.trim()}"`);
  await target.click({ timeout: 10_000 });
}

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  for (let i = 0; i < Math.min(await locator.count().catch(() => 0), 20); i++) {
    if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  }
  return undefined;
}

const exact = (text: string) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');

/** Opens the editor's DRAWS list if it is collapsed (its "Find a draw" box is hidden). */
async function openDrawList(page: Page): Promise<void> {
  if (await page.getByPlaceholder(/find a draw/i).first().isVisible().catch(() => false)) return;
  const rail = page.getByText('Draws', { exact: true });
  let target: Locator | undefined, leftX = Infinity;
  for (let i = 0; i < await rail.count(); i++) {
    const box = await rail.nth(i).boundingBox().catch(() => null);
    if (box && await rail.nth(i).isVisible().catch(() => false) && box.x < leftX) { target = rail.nth(i); leftX = box.x; }
  }
  if (target) { await click(target); await page.waitForTimeout(800); }
}

/** Whether `name` is already one of the draws listed in the DRAWS panel. */
async function drawListed(page: Page, name: string): Promise<boolean> {
  return !!await firstVisible(page.getByText(exact(name)));
}

/**
 * The "+" on the DRAWS panel's header bar (a circled plus at the bar's right end, not
 * necessarily a <button>). Any visible clickable or icon element level with the header
 * text, to its right and within the panel's width, counts; the left rail's "Draws" item
 * has none. Prefers one labelled add/create/new.
 */
async function addDrawCandidates(page: Page): Promise<{ el: Locator; box: { x: number; y: number; width: number; height: number }; label: string }[]> {
  const headers = page.getByText(/^\s*draws\s*$/i);
  const icons = page.locator('button:visible, [role="button"]:visible, svg:visible, img:visible, i:visible, [class*="icon" i]:visible, [class*="add" i]:visible, [class*="plus" i]:visible, [aria-label]:visible, [title]:visible');
  // The DRAWS panel's right edge: its "Find a draw" box spans the panel.
  const find = await page.getByPlaceholder(/find a draw/i).first().boundingBox().catch(() => null);
  for (let i = 0; i < Math.min(await headers.count(), 6); i++) {
    const header = headers.nth(i);
    const box = await header.boundingBox().catch(() => null);
    if (!box || !await header.isVisible().catch(() => false)) continue;
    if (find && (find.y < box.y || Math.abs(find.x - box.x) > 80)) continue; // the left rail's "Draws", not this panel
    const midY = box.y + box.height / 2;
    const right = find ? find.x + find.width + 40 : box.x + 320;
    const found: { el: Locator; box: { x: number; y: number; width: number; height: number }; label: string; score: number }[] = [];
    for (let j = 0; j < Math.min(await icons.count().catch(() => 0), 400); j++) {
      const el = icons.nth(j);
      const c = await el.boundingBox().catch(() => null);
      if (!c || c.width > 60 || c.height > 60) continue; // an icon, not a whole bar
      // The header element can span the whole bar (word and icon share it), so only require
      // the icon to start right of where the word starts, inside the panel, level with it.
      if (c.x < box.x + 30 || c.x > right || Math.abs(c.y + c.height / 2 - midY) > 14) continue;
      if (await el.evaluate((node, text) => (node.textContent ?? '').trim().toLowerCase() === text, 'draws').catch(() => false)) continue;
      const attrs = `${await el.getAttribute('aria-label').catch(() => '')} ${await el.getAttribute('title').catch(() => '')} ${await el.getAttribute('class').catch(() => '')}`;
      const tag = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '?');
      found.push({ el, box: c, label: `<${tag} ${attrs.trim()} x=${Math.round(c.x)}>`, score: (/add|create|new|plus/i.test(attrs) ? 1000 : 0) + c.x });
    }
    if (found.length) return found.sort((p, q) => q.score - p.score);
  }
  return [];
}

/** What is on the DRAWS header bar (tag, class, label, box), for fixing the "+" lookup from a real run. */
async function describeDrawsBar(page: Page): Promise<string> {
  return page.evaluate(() => {
    const header = [...document.querySelectorAll('body *')].find(el => el.children.length === 0 && /^\s*draws\s*$/i.test(el.textContent ?? '') && (el as HTMLElement).offsetParent !== null && el.getBoundingClientRect().x > 30);
    if (!header) return 'no DRAWS header found';
    const h = header.getBoundingClientRect();
    const mid = h.y + h.height / 2;
    return [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.width < 80 && Math.abs(r.y + r.height / 2 - mid) < 20 && r.x > h.x && r.x < h.x + 450;
    }).slice(0, 15).map(el => {
      const r = el.getBoundingClientRect();
      return `<${el.tagName.toLowerCase()} class="${(el.getAttribute('class') ?? '').slice(0, 60)}" aria="${el.getAttribute('aria-label') ?? ''}" cursor=${getComputedStyle(el).cursor} x=${Math.round(r.x)} w=${Math.round(r.width)}>`;
    }).join(' ') || `nothing small found beside the header (header at x=${Math.round(h.x)}, w=${Math.round(h.width)})`;
  }).catch(error => `could not inspect: ${(error as Error).message}`);
}

/** The control a field label belongs to: its own input, or the nearest ancestor holding one. */
async function fieldControl(label: Locator, kind: 'checkbox' | 'value'): Promise<{ container: Locator; control: Locator } | undefined> {
  const selector = kind === 'checkbox'
    ? 'input[type="checkbox"], [role="checkbox"], [role="switch"]'
    : 'select, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), [role="combobox"], [aria-haspopup], [role="button"]';
  for (let depth = 0; depth <= 4; depth++) {
    const container = depth ? label.locator(`xpath=ancestor::*[${depth}]`) : label;
    const controls = container.locator(selector);
    if (await controls.count().catch(() => 0) > 1 && depth > 0) break; // grew past this one field
    const control = await firstVisible(controls) ?? (await controls.count().catch(() => 0) ? controls.first() : undefined);
    if (control) return { container, control };
  }
  return undefined;
}

/** Sets one form field by its label. Returns undefined on success, or what went wrong. */
async function setField(page: Page, panel: Locator, labelText: string, value: string | boolean): Promise<string | undefined> {
  const label = await firstVisible(panel.getByText(exact(labelText)));
  if (!label) return `field "${labelText}" not found`;
  if (typeof value === 'boolean') {
    const field = await fieldControl(label, 'checkbox');
    if (!field) return `"${labelText}" has no checkbox`;
    const checked = async () => (await field.control.isChecked().catch(async () => (await field.control.getAttribute('aria-checked')) === 'true'));
    if (await checked() !== value) await click(label);
    return await checked() === value ? undefined : `could not set "${labelText}" to ${value}`;
  }
  const field = await fieldControl(label, 'value');
  if (!field) return `"${labelText}" has no input or dropdown`;
  const { container, control } = field;
  const tag = await control.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
  const editable = tag === 'input' && !await control.getAttribute('readonly') && !await control.getAttribute('aria-haspopup')
    && (await control.getAttribute('role')) !== 'combobox';
  if (tag === 'select') {
    const done = await control.selectOption({ label: value }).then(() => true, () => false);
    if (!done) return `"${value}" is not an option for "${labelText}" (options: ${(await control.locator('option').allInnerTexts()).map(t => t.trim()).join(', ')})`;
  } else if (editable) {
    await control.fill(value);
  } else {
    await click(control);
    await page.waitForTimeout(500);
    let options = page.getByRole('option');
    if (!await firstVisible(options)) options = page.locator('[role="listbox"] li, ul li');
    const choice = await firstVisible(options.filter({ hasText: exact(value) }));
    if (!choice) {
      const offered = (await options.allInnerTexts().catch(() => [])).map(t => t.trim()).filter(Boolean).slice(0, 20);
      await page.keyboard.press('Escape').catch(() => undefined);
      return `"${value}" is not an option for "${labelText}"${offered.length ? ` (options: ${offered.join(', ')})` : ''}`;
    }
    await click(choice);
    await page.waitForTimeout(400);
  }
  const shown = `${await container.innerText().catch(() => '')} ${await control.inputValue().catch(() => '')}`;
  return shown.toLowerCase().includes(value.toLowerCase()) ? undefined : `"${labelText}" does not show "${value}" after choosing it`;
}

/**
 * Creates a new draw from `config` through the editor's DRAWS "+" > "Create draw" form.
 * In a dry run (live:false) it fills the form, screenshots it and clicks CANCEL. Live, it
 * clicks CREATE DRAW only when every field took its value, so a half-filled draw is never
 * made. Never clicks PUBLISH.
 */
export async function createDraw(page: Page, editorUrl: string, config: NewDrawConfig, live: boolean): Promise<string> {
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  await openDrawList(page);
  if (await drawListed(page, config.name)) return 'SKIP_ALREADY_EXISTS';
  if (config.division && !await firstVisible(page.getByText(exact(config.division)))) {
    return `NEEDS_REVIEW: division "${config.division}" is not in the DRAWS list`;
  }
  const candidates = await addDrawCandidates(page);
  if (!candidates.length) return `NEEDS_REVIEW: the "+" next to DRAWS was not found. Elements on that bar: ${await describeDrawsBar(page)}`;
  // Only a heading counts, not the form's own CREATE DRAW button.
  const heading = page.locator('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="header" i], [class*="heading" i]').filter({ hasText: /^\s*create draw\s*$/i });
  let title: Locator | undefined;
  const tried: string[] = [];
  for (const candidate of candidates.slice(0, 4)) {
    tried.push(candidate.label);
    if (EDITOR.forbiddenClick.test(candidate.label)) continue;
    // Click the icon's centre like a person would; an inner part of an icon may ignore a
    // click dispatched on it, while the element under the pointer handles a real one.
    await page.mouse.click(candidate.box.x + candidate.box.width / 2, candidate.box.y + candidate.box.height / 2);
    await heading.first().waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined);
    title = await firstVisible(heading) ?? await firstVisible(page.getByText(/^\s*create draw\s*$/i).filter({ hasNot: page.locator('button') }));
    if (title && (await title.evaluate(node => node.tagName.toLowerCase()).catch(() => '')) !== 'button') break;
    title = undefined;
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  if (!title) return `NEEDS_REVIEW: the "Create draw" form did not open after clicking: ${tried.join(' ')}. Elements on that bar: ${await describeDrawsBar(page)}`;
  const panel = title.locator('xpath=ancestor::*[.//button[normalize-space()="CREATE DRAW" or normalize-space()="Create Draw" or normalize-space()="Create draw"]][1]');
  const problems: string[] = [];
  const nameProblem = await setField(page, panel, 'Draw name', config.name);
  if (nameProblem) problems.push(nameProblem);
  for (const [label, value] of Object.entries(config.fields)) {
    const problem = await setField(page, panel, label, value);
    console.log(`NEW DRAW ${label}: ${problem ? `NEEDS_REVIEW: ${problem}` : JSON.stringify(value)}`);
    if (problem) problems.push(problem);
  }
  const labels = (await panel.locator('label, legend').allInnerTexts().catch(() => [])).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  console.log(`NEW DRAW form fields: ${[...new Set(labels)].join(' | ')}`);
  await screenshot(page, 'new-draw-form');
  const cancel = await firstVisible(panel.getByRole('button', { name: /^\s*cancel\s*$/i }));
  if (!live || problems.length) {
    if (cancel) await click(cancel); else await page.keyboard.press('Escape');
    return problems.length ? `NEEDS_REVIEW: ${problems.join('; ')}` : 'NOT_SUBMITTED';
  }
  const create = await firstVisible(panel.getByRole('button', { name: /^\s*create draw\s*$/i }));
  if (!create) return 'NEEDS_REVIEW: CREATE DRAW button not found';
  await click(create);
  await title.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
  await openDrawList(page);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !await drawListed(page, config.name)) await page.waitForTimeout(500);
  const saved = await new UtrDrawEditor(page, editorUrl).save();
  await screenshot(page, 'new-draw-created');
  if (saved.startsWith('NEEDS_REVIEW')) return saved;
  return await drawListed(page, config.name) ? 'CREATED' : 'NEEDS_REVIEW: clicked CREATE DRAW but the draw is not in the DRAWS list';
}
