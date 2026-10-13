import fs from 'node:fs';
import type { Locator, Page } from 'playwright';
import { normalizeName } from '../utils/names.ts';
import { screenshot } from './browser.ts';
import { UtrDrawEditor } from './drawEditor.ts';
import { click, exact, firstVisible, openDrawList, setField } from './newDraw.ts';

/**
 * Ad-hoc draws made from the Event Desk Players tab: for each group, select its players in
 * one singles division, "Add to new draw", name it, set Draw type and Format, add it.
 */
export interface GroupDrawsConfig {
  eventUrl: string;
  eventName: string;
  division: string;
  drawType: string;
  format: string;
  groups: { name: string; players: string[] }[];
}

export interface GroupDrawsReport {
  stopped?: string;
  unmatched: string[];
  groups: { name: string; result: string; url?: string; players?: number }[];
  existingDrawsUnchanged?: boolean;
}

const quotes = (value: string) => value.replace(/[‘’ʼ`´]/g, "'");
/** Names and labels compared case-, space- and apostrophe-insensitively (’ vs '). */
export const norm = (value: string) => normalizeName(quotes(value));

export function readGroupsConfig(file = process.env.UTR_GROUPS_CONFIG || 'groups.json'): GroupDrawsConfig {
  if (!fs.existsSync(file)) throw new Error(`${file} not found: it lists the event, the division and each group's players`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GroupDrawsConfig;
}

/** Problems with the group list itself, found before the browser opens. */
export function checkGroupsConfig(config: GroupDrawsConfig): string[] {
  const problems: string[] = [];
  if (!config.eventName?.trim()) problems.push('groups.json has no "eventName"');
  if (!config.division?.trim()) problems.push('groups.json has no "division"');
  if (/doubles/i.test(config.division ?? '')) problems.push(`"${config.division}" is a doubles division; only a singles division is allowed`);
  if (!config.groups?.length) problems.push('groups.json lists no groups');
  const groupNames = new Map<string, string>(), players = new Map<string, string>();
  for (const group of config.groups ?? []) {
    if (!group.name?.trim()) { problems.push('a group has no name'); continue; }
    if (groupNames.has(norm(group.name))) problems.push(`group name "${group.name}" is used twice`);
    groupNames.set(norm(group.name), group.name);
    if (!group.players?.length) problems.push(`${group.name} lists no players`);
    for (const player of group.players ?? []) {
      if (!player.trim()) { problems.push(`${group.name} has a blank player name`); continue; }
      const other = players.get(norm(player));
      if (other) problems.push(`"${player}" is listed in both ${other} and ${group.name}`);
      players.set(norm(player), group.name);
    }
  }
  return problems;
}

/** A row's player name: its first line that reads as a name (ratings, "UR", e-mails and all-caps badges skipped). */
export function rowName(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/\s+[\d(].*$/, '').trim();
    if (!line || line === line.toUpperCase() || line.includes('@')) continue;
    if (/^\p{L}[\p{L}'’.\- ]*$/u.test(line) && line.includes(' ')) return line;
  }
  return undefined;
}

type Row = { index: number; key: string; name: string; text: string; checked: boolean };
const CHECKBOXES = 'input[type="checkbox"], [role="checkbox"]';

/**
 * The player rows on screen: each visible checkbox with the largest ancestor that holds
 * only that checkbox (its row). The header row (with Contact / Division titles) is skipped.
 */
async function readRows(page: Page): Promise<Row[]> {
  const raw = await page.evaluate(selector => [...document.querySelectorAll(selector)].map((box, index) => {
    const rect = box.getBoundingClientRect();
    const style = getComputedStyle(box);
    const visible = (rect.width > 0 || rect.height > 0) && style.visibility !== 'hidden' && style.display !== 'none' && !!(box as HTMLElement).closest('body');
    let row: Element = box, text = '';
    while (row.parentElement && row.parentElement !== document.body && row.parentElement.querySelectorAll(selector).length === 1) {
      row = row.parentElement;
      text = (row as HTMLElement).innerText ?? '';
      if (text.length > 1500) break;
    }
    const checked = (box as HTMLInputElement).checked ?? box.getAttribute('aria-checked') === 'true';
    return { index, visible, text, checked: box.getAttribute('aria-checked') === 'true' || checked === true };
  }), CHECKBOXES);
  const rows: Row[] = [];
  for (const r of raw) {
    if (!r.visible || !r.text || (/\bcontact\b/i.test(r.text) && /\bdivision\b/i.test(r.text))) continue;
    const name = rowName(r.text);
    if (name) rows.push({ index: r.index, key: `${norm(name)}|${norm(r.text)}`, name, text: r.text, checked: r.checked });
  }
  return rows;
}

/** Scrolls the player list (its scrollable container, or the page) to the top, or one screen down. */
async function scrollList(page: Page, mode: 'top' | 'next'): Promise<boolean> {
  return page.evaluate(([selector, how]) => {
    const boxes = [...document.querySelectorAll(selector)];
    let el = boxes[boxes.length - 1]?.parentElement ?? null;
    while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    const scroller = (el ?? document.scrollingElement ?? document.documentElement) as HTMLElement;
    const before = scroller.scrollTop;
    if (how === 'top') scroller.scrollTop = 0; else scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
    return scroller.scrollTop !== before;
  }, [CHECKBOXES, mode] as const);
}

/** Every row of the list, scrolling through it; `visit` may check or uncheck a row as it is seen. */
async function scanRows(page: Page, visit?: (row: Row, checkbox: Locator) => Promise<void>): Promise<Map<string, Row>> {
  const seen = new Map<string, Row>();
  await scrollList(page, 'top');
  await page.waitForTimeout(300);
  for (let pass = 0; pass < 80; pass++) {
    for (const row of await readRows(page)) {
      if (seen.has(row.key)) continue;
      seen.set(row.key, row);
      if (visit) await visit(row, page.locator(CHECKBOXES).nth(row.index));
    }
    if (!await scrollList(page, 'next')) break;
    await page.waitForTimeout(400);
  }
  await scrollList(page, 'top');
  return seen;
}

/** Checks exactly the rows named in `names` and unchecks every other row; returns the names then checked. */
async function selectOnly(page: Page, names: Set<string>): Promise<string[]> {
  await scanRows(page, async (row, checkbox) => {
    if (names.has(norm(row.name)) !== row.checked) { await checkbox.click({ timeout: 10_000 }); await page.waitForTimeout(150); }
  });
  return [...(await scanRows(page)).values()].filter(row => row.checked).map(row => row.name);
}

/** The division filter (shows "All Divisions" until a division is picked, then that division). */
async function divisionControl(page: Page, division: string): Promise<Locator | undefined> {
  const controls = page.locator('select, button, [role="button"], [role="combobox"], [aria-haspopup]');
  for (let i = 0; i < Math.min(await controls.count().catch(() => 0), 200); i++) {
    const control = controls.nth(i);
    if (!await control.isVisible().catch(() => false)) continue;
    const box = await control.boundingBox().catch(() => null);
    if (!box || box.width > 450) continue;
    const text = norm((await control.innerText().catch(() => '')) || await control.inputValue().catch(() => ''));
    if (/^all divisions/.test(text) || text.replace(/[▾▼\s]+$/, '') === norm(division)) return control;
  }
  return undefined;
}

/** Event page > Event Desk > Players tab. Returns the page the Players tab is on (Event Desk may open a tab). */
async function openPlayersTab(page: Page, config: GroupDrawsConfig): Promise<{ page: Page; problem?: string }> {
  await page.goto(config.eventUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const title = ((await page.locator('[data-testid="event-profile.header.event-title"], h1').first().textContent().catch(() => '')) ?? '').trim();
  console.log(`GROUPS event page: "${title}"`);
  if (norm(title) !== norm(config.eventName)) return { page, problem: `the event is "${title}", not "${config.eventName}"` };
  const desk = await firstVisible(page.locator('a, button, [role="button"]').filter({ hasText: /^\s*event desk\s*$/i }));
  if (!desk) return { page, problem: 'the event page has no "Event Desk" link' };
  const [opened] = await Promise.all([page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => undefined), click(desk)]);
  const deskPage = opened ?? page;
  await deskPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  await deskPage.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  return { page: deskPage, problem: await showPlayersTab(deskPage, config.division) };
}

/** Within Event Desk: the left rail's "Players" tab, ready when its division filter shows. */
async function showPlayersTab(page: Page, division: string): Promise<string | undefined> {
  if (!await divisionControl(page, division)) {
    const rail = page.getByText('Players', { exact: true });
    let target: Locator | undefined, leftX = Infinity;
    for (let i = 0; i < Math.min(await rail.count(), 10); i++) {
      const box = await rail.nth(i).boundingBox().catch(() => null);
      if (box && await rail.nth(i).isVisible().catch(() => false) && box.x < leftX) { target = rail.nth(i); leftX = box.x; }
    }
    if (!target) return 'Event Desk has no "Players" tab';
    await click(target);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !await divisionControl(page, division)) await page.waitForTimeout(500);
  return await divisionControl(page, division) ? undefined : 'the Players tab has no division filter ("All Divisions")';
}

/** Picks the division in the Players tab's division filter; never touches the draw filter. */
async function selectDivision(page: Page, division: string): Promise<string | undefined> {
  const control = await divisionControl(page, division);
  if (!control) return 'the division filter is gone';
  const shown = norm((await control.innerText().catch(() => '')) || await control.inputValue().catch(() => '')).replace(/[▾▼\s]+$/, '');
  if (shown === norm(division)) return undefined;
  if (await control.evaluate(el => el.tagName.toLowerCase()).catch(() => '') === 'select') {
    const labels = (await control.locator('option').allInnerTexts()).map(t => t.trim());
    const label = labels.find(l => norm(l) === norm(division));
    if (!label) return `division "${division}" is not offered (divisions: ${labels.join(', ')})`;
    await control.selectOption({ label });
  } else {
    await click(control);
    await page.waitForTimeout(600);
    let options = page.locator('[role="option"]:visible, [role="menuitem"]:visible');
    if (!await options.count()) options = page.locator('[role="listbox"] li:visible, [role="menu"] li:visible, ul li:visible');
    const texts = (await options.allInnerTexts()).map(t => t.trim());
    const at = texts.findIndex(t => norm(t) === norm(division));
    if (at < 0) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return `division "${division}" is not offered (divisions: ${texts.filter(Boolean).join(', ')})`;
    }
    await click(options.nth(at));
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const now = await divisionControl(page, division);
  const after = now ? norm((await now.innerText().catch(() => '')) || await now.inputValue().catch(() => '')).replace(/[▾▼\s]+$/, '') : '';
  return after === norm(division) ? undefined : `picked "${division}" but the filter shows "${after}"`;
}

/** Visible draw names in the DRAWS panel matching `name` exactly, after typing it into "Find a draw". */
async function drawsNamed(page: Page, name: string): Promise<Locator[]> {
  await openDrawList(page);
  const find = await firstVisible(page.getByPlaceholder(/find a draw/i));
  const area = find ? await find.boundingBox().catch(() => null) : null;
  if (find) { await find.fill(name); await page.waitForTimeout(800); }
  const matches = page.getByText(exact(name));
  const found: Locator[] = [];
  for (let i = 0; i < Math.min(await matches.count().catch(() => 0), 30); i++) {
    const match = matches.nth(i);
    if (!await match.isVisible().catch(() => false)) continue;
    const box = await match.boundingBox().catch(() => null);
    // Only the DRAWS panel (below its search box, within its width), never a player row's Draw column.
    if (area && (!box || box.y < area.y || box.x < area.x - 40 || box.x > area.x + area.width + 40)) continue;
    found.push(match);
  }
  return found;
}

async function clearDrawSearch(page: Page): Promise<void> {
  const find = await firstVisible(page.getByPlaceholder(/find a draw/i));
  if (find) { await find.fill(''); await page.waitForTimeout(500); }
}

/** The DRAWS panel's lines (draw and division names as listed), to show nothing existing changed. */
async function drawListLines(page: Page): Promise<string[]> {
  await openDrawList(page);
  await clearDrawSearch(page);
  const find = await firstVisible(page.getByPlaceholder(/find a draw/i));
  if (!find) return [];
  return find.evaluate(input => {
    let el: HTMLElement | null = input.parentElement;
    while (el && !/^\s*draws\b/i.test(el.innerText ?? '')) el = el.parentElement;
    return (el?.innerText ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  });
}

/** Opens "Add to new draw" for the selected players and returns its form (the part holding "Draw name"). */
async function openAddToNewDraw(page: Page): Promise<{ panel?: Locator; problem?: string }> {
  const target = () => firstVisible(page.getByText(/^\s*add to new draw\s*$/i));
  let control = await target();
  if (!control) {
    const menu = await firstVisible(page.locator('button, [role="button"]').filter({ hasText: /^\s*(actions?|bulk actions?|add to draw)\s*[▾▼]?\s*$/i }));
    if (menu) { await click(menu); await page.waitForTimeout(500); control = await target(); }
  }
  if (!control) {
    const offered = (await page.locator('button:visible, [role="button"]:visible').allInnerTexts().catch(() => [])).map(t => t.trim()).filter(Boolean).slice(0, 25);
    return { problem: `"Add to new draw" was not found after selecting the players (controls on the page: ${offered.join(' | ')})` };
  }
  await click(control);
  const label = page.getByText(exact('Draw name'));
  await label.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
  const nameLabel = await firstVisible(label);
  if (!nameLabel) return { problem: '"Add to new draw" did not open a form with a "Draw name" field' };
  const panel = nameLabel.locator('xpath=ancestor::*[.//*[translate(normalize-space(text()), "CANEL", "canel")="cancel"]][1]');
  if (!await panel.count().catch(() => 0)) return { problem: 'the "Add to new draw" form has no CANCEL' };
  return { panel };
}

/** Sets Draw name, Draw type and Format. Returns what could not be set (nothing on success). */
async function fillDrawForm(page: Page, panel: Locator, group: GroupDrawsConfig['groups'][number], config: GroupDrawsConfig): Promise<string[]> {
  const problems: string[] = [];
  const nameProblem = await setField(page, panel, 'Draw name', group.name);
  if (nameProblem) problems.push(nameProblem);
  const fields: [string[], string][] = [
    [['Draw type', 'Type'], config.drawType],
    [['Format', 'Default scoring format', 'Scoring format', 'Match format'], config.format]
  ];
  for (const [labels, value] of fields) {
    let label: string | undefined;
    for (const candidate of labels) if (await firstVisible(panel.getByText(exact(candidate)))) { label = candidate; break; }
    if (!label) { problems.push(`the form has no "${labels[0]}" field`); continue; }
    const problem = await setField(page, panel, label, value);
    console.log(`GROUPS   ${label}: ${problem ? `NEEDS_REVIEW: ${problem}` : JSON.stringify(value)}`);
    if (problem) problems.push(problem);
  }
  // If the form lists the chosen players, they must be exactly this group's.
  const text = norm(await panel.innerText().catch(() => ''));
  const shown = group.players.filter(player => text.includes(norm(player)));
  if (shown.length && shown.length !== group.players.length) {
    problems.push(`the form lists ${shown.length} of ${group.players.length} players (missing: ${group.players.filter(p => !shown.includes(p)).join(', ')})`);
  }
  return problems;
}

/** The form's submit control (ADD / ADD DRAW / CREATE DRAW…), the lowest one in the form, never its heading. */
async function submitControl(panel: Locator): Promise<Locator | undefined> {
  const candidates = panel.locator('button, [role="button"], a, div, span').filter({ hasText: /^\s*(add draw|add to draw|add|create draw|create)\s*$/i });
  let best: Locator | undefined, bottom = -Infinity;
  for (let i = 0; i < Math.min(await candidates.count().catch(() => 0), 20); i++) {
    const c = candidates.nth(i);
    if (!await c.isVisible().catch(() => false)) continue;
    if (/^h[1-6]$/.test(await c.evaluate(el => el.tagName.toLowerCase()).catch(() => ''))) continue;
    const box = await c.boundingBox().catch(() => null);
    if (box && box.y >= bottom) { best = c; bottom = box.y; }
  }
  return best;
}

async function cancelForm(page: Page, panel: Locator): Promise<void> {
  const cancel = await firstVisible(panel.getByRole('button', { name: /^\s*cancel\s*$/i })) ?? await firstVisible(panel.getByText(/^\s*cancel\s*$/i));
  if (cancel) await click(cancel); else await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/**
 * Checks everything first (event, Event Desk, Players tab, division, every listed player
 * matched exactly once in that singles division, no draw already named like a group), and
 * stops before creating anything if any check fails. Then, live, creates one ad-hoc draw
 * per group and verifies it; a dry run fills each form and cancels it instead.
 */
export async function createGroupDraws(start: Page, config: GroupDrawsConfig, live: boolean): Promise<GroupDrawsReport> {
  const report: GroupDrawsReport = { unmatched: [], groups: [] };
  const stop = (reason: string) => { report.stopped = reason; return report; };
  const configProblems = checkGroupsConfig(config);
  if (configProblems.length) return stop(configProblems.join('; '));

  const opened = await openPlayersTab(start, config);
  const page = opened.page;
  if (opened.problem) { await screenshot(page, 'groups-stopped'); return stop(opened.problem); }
  const divisionProblem = await selectDivision(page, config.division);
  if (divisionProblem) { await screenshot(page, 'groups-stopped'); return stop(divisionProblem); }
  console.log(`GROUPS division: "${config.division}"`);

  const rows = [...(await scanRows(page)).values()];
  const outside = rows.filter(row => !norm(row.text).includes(norm(config.division)));
  console.log(`GROUPS players listed in the division: ${rows.length}`);
  await screenshot(page, 'groups-division');
  if (outside.length) {
    return stop(`${outside.length} listed player(s) do not show "${config.division}" as their division (e.g. ${outside.slice(0, 3).map(r => `${r.name}: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`).join(' / ')})`);
  }
  const byName = new Map<string, Row[]>();
  for (const row of rows) byName.set(norm(row.name), [...(byName.get(norm(row.name)) ?? []), row]);
  for (const group of config.groups) {
    for (const player of group.players) {
      const found = byName.get(norm(player)) ?? [];
      if (found.length !== 1) report.unmatched.push(`${player} (${group.name}): ${found.length ? `${found.length} players with this name` : 'not in this division'}`);
    }
  }
  const total = config.groups.reduce((n, g) => n + g.players.length, 0);
  console.log(`GROUPS players matched: ${total - report.unmatched.length} of ${total}`);
  if (report.unmatched.length) return stop(`${report.unmatched.length} listed player(s) could not be matched exactly once in "${config.division}"; nothing was created`);

  const before = await drawListLines(page);
  for (const group of config.groups) {
    const existing = await drawsNamed(page, group.name);
    if (existing.length) {
      await clearDrawSearch(page);
      return stop(`a draw named "${group.name}" already exists; nothing was created. Give this group a different name in groups.json`);
    }
  }
  await clearDrawSearch(page);

  for (const group of config.groups) {
    console.log(`GROUPS ${group.name}: selecting ${group.players.length} players`);
    const wanted = new Set(group.players.map(norm));
    const selected = await selectOnly(page, wanted);
    const extra = selected.filter(name => !wanted.has(norm(name)));
    const missing = group.players.filter(player => !selected.some(name => norm(name) === norm(player)));
    if (extra.length || missing.length) {
      await selectOnly(page, new Set());
      report.groups.push({ name: group.name, result: `NEEDS_REVIEW: selection did not hold (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})` });
      return stop(`selecting ${group.name}'s players did not work as expected`);
    }
    const form = await openAddToNewDraw(page);
    if (!form.panel) {
      await screenshot(page, 'groups-stopped');
      await selectOnly(page, new Set());
      report.groups.push({ name: group.name, result: `NEEDS_REVIEW: ${form.problem}` });
      return stop(form.problem!);
    }
    const problems = await fillDrawForm(page, form.panel, group, config);
    await screenshot(page, `groups-${group.name.replace(/\W+/g, '-')}-form`);
    if (!live || problems.length) {
      await cancelForm(page, form.panel);
      await selectOnly(page, new Set());
      report.groups.push({ name: group.name, result: problems.length ? `NEEDS_REVIEW: ${problems.join('; ')}` : 'NOT_SUBMITTED' });
      if (problems.length) return stop(`the form for ${group.name} could not be filled`);
      continue;
    }
    const submit = await submitControl(form.panel);
    if (!submit) {
      await cancelForm(page, form.panel);
      await selectOnly(page, new Set());
      report.groups.push({ name: group.name, result: 'NEEDS_REVIEW: the form has no ADD / CREATE control' });
      return stop('the "Add to new draw" form has no submit control');
    }
    await click(submit);
    await page.getByText(exact('Draw name')).first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
    const saved = await new UtrDrawEditor(page, page.url()).save();
    if (saved.startsWith('NEEDS_REVIEW')) { report.groups.push({ name: group.name, result: saved }); return stop(saved); }

    let found = await drawsNamed(page, group.name);
    for (let wait = 0; wait < 20 && found.length !== 1; wait++) { await page.waitForTimeout(500); found = await drawsNamed(page, group.name); }
    if (found.length !== 1) {
      report.groups.push({ name: group.name, result: `NEEDS_REVIEW: after adding, ${found.length} draws named "${group.name}" are listed` });
      return stop(`could not verify ${group.name} in the DRAWS list`);
    }
    await click(found[0]!);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const url = page.url();
    const count = Number((await page.locator('body').innerText().catch(() => '')).match(/players\s*\((\d+)\)/i)?.[1] ?? NaN);
    await screenshot(page, `groups-${group.name.replace(/\W+/g, '-')}-created`);
    report.groups.push({
      name: group.name, url, players: Number.isNaN(count) ? undefined : count,
      result: Number.isNaN(count) || count === group.players.length ? 'CREATED' : `NEEDS_REVIEW: created, but it shows ${count} players, not ${group.players.length}`
    });
    console.log(`GROUPS ${group.name}: ${report.groups.at(-1)!.result} ${url}`);
    await clearDrawSearch(page);
    if (await showPlayersTab(page, config.division) || await selectDivision(page, config.division)) return stop(`could not return to the Players tab after creating ${group.name}`);
    if (report.groups.at(-1)!.result !== 'CREATED') return stop(`${group.name} needs review; the remaining groups were not created`);
  }

  const after = await drawListLines(page);
  const missingLines = before.filter(line => !after.includes(line));
  report.existingDrawsUnchanged = missingLines.length === 0;
  if (missingLines.length) console.log(`GROUPS draws list lines no longer shown: ${missingLines.join(' | ')}`);
  return report;
}
