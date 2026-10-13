import type { Locator, Page } from 'playwright';
import type { MatchRow } from '../models/match.ts';
import { parseScore, validateWinner } from '../bracket/bracket.ts';
import { firstVisible, screenshot } from './browser.ts';
import { lineNamesPlayer, playerLine, renderedScoreMatches, scoreFieldValues, type PrepareResult } from './eventPage.ts';
import { clickAndAwaitMutation } from './network.ts';
import { EDITOR, SELECTORS } from './selectors.ts';

const SUPPORTED_ROUND = 'R16';

/** `R16-3` -> 3, `QF2` -> 2. */
export function matchNumber(matchId: string): number | undefined {
  const n = matchId.match(/(\d+)$/)?.[1];
  return n ? Number(n) : undefined;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Whether an element sits inside "Players not in draw": below its header (sections above
 * it are PLACED / NOT PLACED / WAITLIST) and starting within the header's own width (the
 * bracket's match cards start to the right of the sidebar).
 */
export function inRosterSection(box: Box | null, header: Box): boolean {
  return !!box && box.y >= header.y + header.height - 2 && box.x >= header.x - 80 && box.x <= header.x + Math.max(header.width, 150) + 20;
}

/**
 * Page object for UTR's Event Desk draw editor (`/events/<id>/draws?v=drawEditor&d=<draw>`).
 *
 * Two rounds are shown side by side, so "Match #1" appears in both columns. The
 * leftmost column is the round selected in the header, and every action is scoped
 * to the single card that holds that match's header.
 *
 * Edits are a draft until the editor's SAVE is clicked (see save()); PUBLISH is separate. This class never clicks
 * anything whose label matches EDITOR.forbiddenClick, publish in particular.
 */
export class UtrDrawEditor {
  readonly page: Page;
  readonly url: string;
  constructor(page: Page, url: string) { this.page = page; this.url = url; }

  async open(): Promise<void> {
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await this.page.getByText(/^Match #\d+/).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    await this.ensureDraw();
    if (await this.page.locator('[data-testid="modal.login-popup.overlay"]').isVisible().catch(() => false)) {
      throw new Error('UTR is showing its login pop-up: the session is not logged in');
    }
  }

  /**
   * The editor ignores the `d=` draw id on a direct load and shows its own default
   * draw (often Group 01), so pick the draw by name from the sidebar instead.
   */
  async ensureDraw(name = process.env.UTR_DRAW_NAME || 'Playoff'): Promise<void> {
    const onBracket = () => this.page.getByText(/^Round of 16/).first().isVisible().catch(() => false);
    // The editor renders its bracket after the page loads; give the configured draw a chance to appear first.
    await Promise.race([
      this.page.getByText(/^Round of 16/).first().waitFor({ state: 'visible', timeout: 10_000 }),
      this.page.getByText(name, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
    ]).catch(() => undefined);
    await this.page.waitForTimeout(1_000);
    if (await onBracket()) return;
    const collect = async () => {
      const candidates = this.page.getByText(name, { exact: true });
      const list: { item: Locator; x: number }[] = [];
      for (let i = 0; i < await candidates.count(); i++) {
        const item = candidates.nth(i);
        const box = await item.boundingBox().catch(() => null);
        if (box && await item.isVisible().catch(() => false)) list.push({ item, x: box.x });
      }
      return list.sort((p, q) => p.x - q.x);
    };
    let found = await collect();
    if (!found.length) {
      // The draw list is collapsed until the rail's "Draws" button is clicked.
      const rail = this.page.getByText('Draws', { exact: true });
      let railButton: Locator | undefined, railX = Infinity;
      for (let i = 0; i < await rail.count(); i++) {
        const box = await rail.nth(i).boundingBox().catch(() => null);
        if (box && await rail.nth(i).isVisible().catch(() => false) && box.x < railX) { railButton = rail.nth(i); railX = box.x; }
      }
      if (railButton) {
        console.log('DRAW SELECT: opening the Draws list');
        await this.safeClick(railButton);
        await this.page.waitForTimeout(800);
        found = await collect();
      }
    }
    console.log(`DRAW SELECT: looking for "${name}" in the draw list: ${found.length} visible match(es)`);
    if (!found.length) {
      await screenshot(this.page, 'draw-editor-draw-not-found');
      throw new Error(`Draw "${name}" was not found in the editor's draw list (screenshot: draw-editor-draw-not-found.png)`);
    }
    // Click the label; if the bracket does not appear, try its row, then its container.
    for (const target of [found[0]!.item, found[0]!.item.locator('xpath=..'), found[0]!.item.locator('xpath=../..')]) {
      await this.safeClick(target);
      await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await this.page.getByText(/^Round of 16/).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
      if (await onBracket()) { console.log(`DRAW SELECT: "${name}" opened`); await this.page.waitForTimeout(500); return; }
    }
    console.log(`DRAW SELECT: clicked "${name}" but the Round of 16 bracket did not appear`);
  }

  /** The sidebar's "PLAYERS NOT IN DRAW (n)" section header (a collapsible bar). */
  private rosterHeader(): Locator {
    return this.page.getByText(/^players not in draw/i).first();
  }

  /** Opens "Players not in draw" if it shows no rows. */
  private async openRosterSection(): Promise<void> {
    const header = this.rosterHeader();
    if (!await header.isVisible().catch(() => false) || await this.sectionShowsRows()) return;
    console.log('ROSTER: expanding "Players not in draw"');
    await this.safeClick(header);
    await this.page.waitForTimeout(800);
  }

  /**
   * Finds `name`'s row inside the sidebar's "Players not in draw" section, typing into
   * "Filter Players" first. Only rows below that section's header and in the sidebar's
   * column count, so a name in a match card or in the PLACED section is never taken for
   * it. The section starts collapsed; when it does not expose aria-expanded, the first
   * search that finds nothing clicks its header once to open it, and clicks again to
   * restore it if that did not help. Returns 'missing' for a player already in the draw
   * (their row has left this section) as well as for an unknown name.
   */
  private async searchRoster(name: string, patience = 3_000): Promise<{ status: 'exact'|'ambiguous'|'missing'; row?: Locator }> {
    const filter = this.page.getByPlaceholder(/filter players/i).first();
    if (await filter.count().catch(() => 0)) {
      await filter.fill('').catch(() => undefined);
      await filter.fill(name.split(' ')[0] ?? name).catch(() => undefined);
    }
    const collect = async () => {
      const header = this.rosterHeader();
      const headerBox = await header.isVisible().catch(() => false) ? await header.boundingBox().catch(() => null) : null;
      const candidates = this.page.getByText(name, { exact: false });
      const matches: { row: Locator; text: string }[] = [];
      for (let i = 0; i < Math.min(await candidates.count(), 25); i++) {
        const row = candidates.nth(i);
        if (!await row.isVisible().catch(() => false)) continue; // skips the other, currently hidden, draws on this page
        if (headerBox && !inRosterSection(await row.boundingBox().catch(() => null), headerBox)) continue;
        const text = ((await row.innerText().catch(() => '')) || '').trim();
        const firstLine = text.split('\n')[0] ?? text;
        // A roster row is short (name + rating + city, a few lines); a wrapping container
        // repeats the same text at greater length, so length bounds out the container.
        if (lineNamesPlayer(firstLine, name) && text.length < 120) matches.push({ row, text });
      }
      return matches;
    };
    // The real site's filter list re-renders after a network round trip, unlike the local
    // mock; poll instead of a single fixed wait so this does not race ahead of it.
    const poll = async (ms: number) => {
      let found = await collect();
      const deadline = Date.now() + ms;
      while (!found.length && Date.now() < deadline) {
        await this.page.waitForTimeout(300);
        found = await collect();
      }
      return found;
    };
    let found = await poll(patience);
    // Not found: only if the section shows nothing at all is it collapsed (it can close
    // again after an add re-renders the sidebar). Never click it while it shows rows.
    if (!found.length && patience > 0 && await this.rosterHeader().isVisible().catch(() => false) && !await this.sectionShowsRows()) {
      console.log('ROSTER: expanding "Players not in draw"');
      await this.safeClick(this.rosterHeader());
      await this.page.waitForTimeout(800);
      found = await poll(patience);
    }
    if (!found.length) return { status: 'missing' };
    // A row's own name element and its wrapping row both match (the wrapper's text is
    // the name plus its trailing icon/rating/city text); keep only the shortest match(es).
    const minLen = Math.min(...found.map(f => f.text.length));
    const leaf = found.filter(f => f.text.length === minLen);
    return leaf.length > 1 ? { status: 'ambiguous' } : { status: 'exact', row: leaf[0]!.row };
  }

  /**
   * Whether "Players not in draw" is showing its rows. It is the sidebar's last section,
   * so its rows are the only text after its header inside the sidebar: when collapsed,
   * nothing follows the header. The filter is cleared for the check so a search that
   * matched nobody does not look like a collapsed section.
   */
  private async sectionShowsRows(): Promise<boolean> {
    const header = this.rosterHeader();
    if (!await header.isVisible().catch(() => false)) return false;
    const filter = this.page.getByPlaceholder(/filter players/i).first();
    const previous = await filter.inputValue().catch(() => '');
    if (previous) { await filter.fill('').catch(() => undefined); await this.page.waitForTimeout(1_000); }
    // Smallest ancestor holding the header and at least one other section header.
    const lower = 'translate(normalize-space(text()), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")';
    const sidebar = header.locator(`xpath=ancestor::*[.//*[starts-with(${lower}, "placed") or starts-with(${lower}, "waitlist")]][1]`);
    const text = ((await sidebar.innerText().catch(() => '')) || '');
    const at = text.search(/players not in draw[^\n]*/i);
    const after = at < 0 ? '' : text.slice(at).replace(/^players not in draw[^\n]*/i, '').trim();
    if (previous) { await filter.fill(previous).catch(() => undefined); await this.page.waitForTimeout(300); }
    return after.length > 0;
  }

  /**
   * The row's own menu trigger: the rightmost control in the smallest ancestor of the
   * name that holds one, stopping before that ancestor grows past a single row. The
   * leading checkbox is never picked (it is an input, and leftmost besides).
   */
  private async rowMenuTrigger(nameEl: Locator): Promise<Locator | undefined> {
    for (let depth = 1; depth <= 6; depth++) {
      const container = nameEl.locator(`xpath=ancestor::*[${depth}]`);
      const text = ((await container.innerText().catch(() => '')) || '').trim();
      if (text.length > 200) break; // grew past one row into the list
      const controls = [
        container.locator('button:visible, [role="button"]:visible, [aria-haspopup]:visible, [class*="more" i]:visible, [class*="menu" i]:visible, [class*="action" i]:visible'),
        container.getByText(/^(\.\.\.|…|⋯|\+)$/)
      ];
      let best: Locator | undefined, bestX = -Infinity;
      for (const group of controls) {
        for (let i = 0; i < Math.min(await group.count().catch(() => 0), 10); i++) {
          const control = group.nth(i);
          if (!await control.isVisible().catch(() => false)) continue;
          const box = await control.boundingBox().catch(() => null);
          if (box && box.x > bestX) { best = control; bestX = box.x; }
        }
      }
      if (best) return best;
    }
    return undefined;
  }

  /**
   * UTR's match-card "Select a player" picker only searches players already on this
   * draw's roster (the left sidebar's "Players not in draw" list; it shows "No players
   * to add..." for everyone else, however they are typed). This adds each name's row
   * from that sidebar to the draw, via its own "Add to Draw" action, before any match
   * slot is touched. Returns one status per unique name; never clicks anything in live:false.
   */
  async addPlayersToDraw(names: string[], live: boolean): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    await this.openRosterSection();
    for (const name of [...new Set(names)]) {
      const found = await this.searchRoster(name);
      if (found.status === 'missing') { results[name] = 'not listed under "Players not in draw" (already in the draw, or the name differs from UTR)'; continue; }
      if (found.status === 'ambiguous') { results[name] = 'NEEDS_REVIEW: ambiguous in "Players not in draw"'; continue; }
      if (!live) { results[name] = 'found'; continue; }
      const trigger = await this.rowMenuTrigger(found.row!);
      if (!trigger) { results[name] = 'NEEDS_REVIEW: no "..." menu found on this player\'s row'; continue; }
      await this.safeClick(trigger);
      const addItem = this.page.getByText('Add to Draw', { exact: true }).first();
      await addItem.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
      if (!await addItem.isVisible().catch(() => false)) {
        await this.page.keyboard.press('Escape');
        results[name] = 'NEEDS_REVIEW: "Add to Draw" menu item not found';
        continue;
      }
      await this.safeClick(addItem);
      // The real site adds the player over the network; poll for the row to leave this
      // list instead of trusting a fixed wait to outlast that round trip.
      const deadline = Date.now() + 5_000;
      let stillListed: 'exact'|'ambiguous'|'missing' = 'exact';
      while (Date.now() < deadline) {
        stillListed = (await this.searchRoster(name, 0)).status;
        if (stillListed === 'missing') break;
        await this.page.waitForTimeout(300);
      }
      results[name] = stillListed === 'missing' ? 'added' : 'NEEDS_REVIEW: still listed in "Players not in draw" after Add to Draw';
    }
    await this.page.getByPlaceholder(/filter players/i).first().fill('').catch(() => undefined);
    await screenshot(this.page, 'draw-roster-after-add');
    return results;
  }

  /** Throws unless the page looks like the expected single-elimination draw. */
  async verifyDraw(expected = process.env.UTR_DRAW_NAME || 'Playoff'): Promise<string> {
    const text = await this.page.locator('body').innerText();
    if (!/Round of 16/i.test(text)) {
      await screenshot(this.page, 'draw-editor-wrong-draw');
      const seen = text.split('\n').map(l => l.trim()).filter(l => /round|elimination|robin|group|playoff/i.test(l)).slice(0, 12).join(' | ');
      throw new Error(`This is not the Round of 16 bracket for "${expected}". The page shows: ${seen || 'no draw information'} (screenshot: draw-editor-wrong-draw.png)`);
    }
    const description = text.match(/(Single Elimination|Round Robin)[^\n]*/i)?.[0] ?? '';
    if (!/Single Elimination/i.test(description)) throw new Error(`Expected a single-elimination draw but found "${description || 'unknown'}"`);
    if (expected && !text.includes(expected)) throw new Error(`Draw "${expected}" is not listed on this page`);
    return description.trim();
  }

  /** Never click publish/delete-style controls, whatever the selector resolved to. */
  private async safeClick(target: Locator): Promise<void> {
    const label = `${await target.innerText().catch(() => '')} ${await target.getAttribute('aria-label').catch(() => '')}`;
    if (EDITOR.forbiddenClick.test(label)) throw new Error(`Refusing to click "${label.trim()}"`);
    await target.click({ timeout: 10_000 });
  }

  /** The card for Match #n in the leftmost (selected) round column. */
  async matchCard(n: number): Promise<Locator | undefined> {
    const headers = this.page.getByText(new RegExp(`^Match #${n}\\b`));
    const count = await headers.count();
    let best: { index: number; x: number } | undefined;
    for (let i = 0; i < count; i++) {
      const box = await headers.nth(i).boundingBox().catch(() => null);
      if (box && (!best || box.x < best.x)) best = { index: i, x: box.x };
    }
    if (!best) return undefined;
    // Smallest ancestor holding a Score button is the card.
    return headers.nth(best.index).locator('xpath=ancestor::*[.//button[normalize-space()="Score"]][1]');
  }

  async cardText(card: Locator): Promise<string> {
    return card.evaluate(element => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (text) parts.push(text);
      }
      return parts.join('\n');
    }).catch(() => '');
  }

  /**
   * Lets the bracket re-render after an edit. Edits are only a draft ("Unsaved changes!")
   * until SAVE is clicked, so this never reloads: a reload would throw the draft away.
   */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
  }

  /** Polls Match #n's card until `done` holds for its text, without reloading the page. */
  private async waitForCard(n: number, done: (text: string) => boolean, ms = 8_000): Promise<string> {
    const deadline = Date.now() + ms;
    let text = '';
    do {
      const card = await this.matchCard(n);
      text = card ? await this.cardText(card) : '';
      if (done(text)) return text;
      await this.page.waitForTimeout(300);
    } while (Date.now() < deadline);
    return text;
  }

  /**
   * Clicks the editor's own SAVE (next to DISCARD, shown with "Unsaved changes!"), never
   * a Save inside a dialog, and waits for the unsaved notice to clear. Never publishes.
   */
  async save(): Promise<string> {
    await this.page.keyboard.press('Escape').catch(() => undefined);
    const unsaved = () => this.page.getByText(/unsaved changes/i).first().isVisible().catch(() => false);
    const buttons = this.page.getByRole('button', { name: /^\s*save\s*$/i });
    let target: Locator | undefined, topY = Infinity;
    for (let i = 0; i < Math.min(await buttons.count().catch(() => 0), 10); i++) {
      const button = buttons.nth(i);
      if (!await button.isVisible().catch(() => false)) continue;
      if (await button.locator('xpath=ancestor::*[@role="dialog" or @aria-modal="true"]').count().catch(() => 0)) continue;
      const box = await button.boundingBox().catch(() => null);
      if (box && box.y < topY) { target = button; topY = box.y; }
    }
    if (!target) return await unsaved() ? 'NEEDS_REVIEW: "Unsaved changes!" is shown but no SAVE button was found' : 'NO_CHANGES';
    await this.safeClick(target);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && await unsaved()) await this.page.waitForTimeout(500);
    await screenshot(this.page, 'draw-after-save');
    return await unsaved() ? 'NEEDS_REVIEW: clicked SAVE but "Unsaved changes!" is still shown' : 'SAVED';
  }

  /** The visible input nearest the card: the type-to-filter box the picker opens, not the page's own player-list filter. */
  private async nearestInput(card: Locator): Promise<Locator | undefined> {
    const cardBox = await card.boundingBox();
    const inputs = this.page.locator('input:visible:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])');
    const total = Math.min(await inputs.count(), 30);
    let best: { el: Locator; d: number } | undefined;
    for (let i = 0; i < total; i++) {
      const el = inputs.nth(i);
      const box = await el.boundingBox().catch(() => null);
      if (!box || !cardBox) continue;
      const d = Math.hypot(box.x - cardBox.x, box.y - cardBox.y);
      if (!best || d < best.d) best = { el, d };
    }
    return best?.el;
  }

  /**
   * Clicks the card's first empty slot if it is still showing the "Select a player" label
   * (a second search on the same open slot does not need to click it again), then types
   * `query` into the picker's type-to-filter box and returns the result rows. UTR's picker
   * shows "No players to add..." until a few characters are typed, so every search needs a
   * query; it is never a static list.
   */
  private async searchSlot(card: Locator, query: string): Promise<{ texts: string[]; items: Locator[] }> {
    const native = card.locator('select').first();
    if (await native.count() && await native.isVisible().catch(() => false)) {
      const texts = (await native.locator('option').allTextContents()).map(t => t.trim());
      return { texts, items: texts.map((_, i) => native.locator('option').nth(i)) };
    }
    const slot = card.getByText(EDITOR.emptySlot, { exact: true }).first();
    if (await slot.isVisible().catch(() => false)) {
      await this.safeClick(slot);
      await this.page.waitForTimeout(400);
    }
    const input = await this.nearestInput(card);
    if (!input) return { texts: [], items: [] };
    await input.fill('').catch(() => undefined);
    await input.pressSequentially(query, { delay: 40 }).catch(() => input.fill(query));
    // Only rows that open next to the typed-in box are the picker's results: the sidebar's
    // own player rows (PLACED, Players not in draw) are list items too, and would otherwise
    // be counted alongside the picker's row for the same player.
    const inputBox = await input.boundingBox().catch(() => null);
    const near = async (locator: Locator) => {
      const kept: { item: Locator; text: string }[] = [];
      for (let i = 0; i < Math.min(await locator.count().catch(() => 0), 80); i++) {
        const item = locator.nth(i);
        const box = await item.boundingBox().catch(() => null);
        if (inputBox && (!box || box.x < inputBox.x - 50 || box.x > inputBox.x + 450 || box.y < inputBox.y - 400 || box.y > inputBox.y + 700)) continue;
        const text = ((await item.innerText().catch(() => '')) || '').trim();
        if (!text || /^(clear|bye)$/i.test(text)) continue; // the picker's own quick actions, never a player
        kept.push({ item, text });
      }
      return kept;
    };
    // Prefer specific row roles; only fall back to generic class matching if none are found,
    // since a class-based selector can also match the results panel that wraps the rows,
    // double-counting every row once as itself and once as part of that wrapper's text.
    const specific = this.page.locator('li:visible, [role="option"]:visible, [role="menuitem"]:visible');
    // The real site's results re-render after a network round trip, unlike the local mock;
    // poll instead of a single fixed wait so this does not race ahead of it.
    let rows = await near(specific);
    const deadline = Date.now() + 5_000;
    while (!rows.length && Date.now() < deadline) { await this.page.waitForTimeout(300); rows = await near(specific); }
    if (rows.length) { await this.page.waitForTimeout(300); rows = await near(specific); } // let a just-appeared list finish rendering
    else rows = await near(this.page.locator('[class*="option" i]:visible, [class*="result" i]:visible'));
    const items = rows.map(r => r.item), texts = rows.map(r => r.text);
    return { texts, items };
  }

  private async fillSlot(card: Locator, name: string): Promise<'exact'|'normalized'|'ambiguous'|'missing'> {
    const { texts, items } = await this.searchSlot(card, name.split(' ')[0] ?? name);
    const matches = texts.map((t, i) => lineNamesPlayer(t.split('\n')[0] ?? t, name) ? i : -1).filter(i => i >= 0);
    if (matches.length > 1) { await this.page.keyboard.press('Escape'); return 'ambiguous'; }
    if (!matches.length) { await this.page.keyboard.press('Escape'); return 'missing'; }
    const chosen = texts[matches[0]!]!;
    await this.safeClick(items[matches[0]!]!);
    return chosen.split('\n')[0]!.trim() === name.trim() ? 'exact' : 'normalized';
  }

  /** Puts the two players of a Round of 16 match into the bracket slots. */
  async createMatch(row: MatchRow, live: boolean): Promise<PrepareResult> {
    if (row.round !== SUPPORTED_ROUND) return { result: 'SKIP_ALREADY_EXISTS' }; // later rounds fill from results
    const n = matchNumber(row.match_id);
    if (!n) return { result: 'NEEDS_REVIEW: cannot read a match number from the match_id' };
    const card = await this.matchCard(n);
    if (!card) return { result: `NEEDS_REVIEW: Match #${n} not found in the Round of 16` };
    const text = await this.cardText(card);
    const hasA = playerLine(text, row.player_a) >= 0, hasB = playerLine(text, row.player_b) >= 0;
    if (hasA && hasB) return { result: 'SKIP_ALREADY_EXISTS', utrMatchId: `R16-${n}`, utrMatchUrl: this.url };
    const empty = (text.match(new RegExp(EDITOR.emptySlot, 'g')) ?? []).length;
    const occupied = 2 - empty;
    if (occupied > 0 && !(hasA || hasB)) return { result: `NEEDS_REVIEW: Match #${n} already has different players` };
    if (!live) {
      // Dry run never adds anyone to the roster, so the match-card picker (which only
      // searches the roster) would wrongly report everyone as missing. Check the sidebar
      // "Players not in draw" list instead; fall back to the picker only for a player
      // already on the roster from an earlier run, whose sidebar row is gone by then.
      const find = async (name: string) => {
        const sidebar = await this.searchRoster(name);
        if (sidebar.status !== 'missing') return sidebar.status === 'exact' ? 1 : 2;
        const { texts } = await this.searchSlot(card, name.split(' ')[0] ?? name);
        return texts.filter(t => lineNamesPlayer(t.split('\n')[0] ?? t, name)).length;
      };
      const a = await find(row.player_a), b = await find(row.player_b);
      await this.page.keyboard.press('Escape');
      await screenshot(this.page, `${row.match_id}-before-submit`);
      const state = (c: number) => c === 1 ? 'exact' : c === 0 ? 'missing' : 'ambiguous';
      if (a !== 1 || b !== 1) return { result: `NEEDS_REVIEW: player A ${state(a)}, player B ${state(b)}`, playerA: state(a), playerB: state(b) };
      return { result: 'NOT_SUBMITTED', playerA: state(a), playerB: state(b), submitAvailable: true };
    }
    let a = 'exact', b = 'exact';
    if (!hasA) {
      a = await this.fillSlot(card, row.player_a);
      if (a === 'missing' || a === 'ambiguous') return { result: `NEEDS_REVIEW: player A ${a}`, playerA: a };
      await this.settle();
    }
    if (!hasB) {
      const fresh = (await this.matchCard(n))!;
      b = await this.fillSlot(fresh, row.player_b);
      if (b === 'missing' || b === 'ambiguous') return { result: `NEEDS_REVIEW: player B ${b}`, playerA: a, playerB: b };
      await this.settle();
    }
    const after = await this.waitForCard(n, t => playerLine(t, row.player_a) >= 0 && playerLine(t, row.player_b) >= 0);
    await screenshot(this.page, `${row.match_id}-created`);
    if (playerLine(after, row.player_a) < 0 || playerLine(after, row.player_b) < 0) {
      return { result: 'NEEDS_REVIEW: players are not shown in the bracket after selecting them', playerA: a, playerB: b };
    }
    return { result: 'CREATED', playerA: a, playerB: b, submitAvailable: true, utrMatchId: `R16-${n}`, utrMatchUrl: this.url };
  }

  /** Enters a Round of 16 score through the card's Score dialog. */
  async enterScore(row: MatchRow, live: boolean): Promise<string> {
    validateWinner(row);
    if (row.round !== SUPPORTED_ROUND) return 'NEEDS_REVIEW: scoring is only automated for the Round of 16; later rounds are not supported yet';
    if (row.utr_sync_status === 'SCORE_SYNCED') return 'SKIP_ALREADY_EXISTS';
    const n = matchNumber(row.match_id);
    const card = n ? await this.matchCard(n) : undefined;
    if (!card) return 'NEEDS_REVIEW: match not found in the bracket';
    const text = await this.cardText(card);
    if (playerLine(text, row.player_a) < 0 || playerLine(text, row.player_b) < 0) return 'NEEDS_REVIEW: players are not in this bracket slot yet';
    const aFirst = playerLine(text, row.player_a) < playerLine(text, row.player_b);
    const sets = parseScore(row.score);
    if (renderedScoreMatches(text, sets, aFirst)) return 'SKIP_ALREADY_EXISTS';
    const button = card.getByRole('button', { name: 'Score', exact: true }).first();
    if (await button.isDisabled().catch(() => false)) return 'NEEDS_REVIEW: Score button is disabled for this match';
    await this.safeClick(button);
    const dialogSelector = SELECTORS.dialog.map(s => `${s}:visible`).join(', ');
    const dialog = this.page.locator(dialogSelector).last();
    await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    const scope: Locator | Page = await dialog.isVisible().catch(() => false) ? dialog : this.page;
    const fields = scope.locator(SELECTORS.scoreInputs.join(','));
    const count = await fields.count();
    if (count < sets.length * 2) return 'NEEDS_REVIEW: UTR score format does not match CSV';
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const field = fields.nth(i);
      labels.push((await field.getAttribute('aria-label')) ?? (await field.getAttribute('name')) ?? (await field.getAttribute('placeholder')) ?? '');
    }
    const values = scoreFieldValues(labels, sets, aFirst);
    for (let i = 0; i < count; i++) if (values[i] !== undefined) await fields.nth(i).fill(String(values[i]));
    const submit = await firstVisible(scope, SELECTORS.finalScore);
    await screenshot(this.page, `${row.match_id}-score-before-submit`);
    if (!submit) return 'NEEDS_REVIEW: score submit control not found';
    if (!live) { await this.page.keyboard.press('Escape'); return 'NOT_SUBMITTED'; }
    await clickAndAwaitMutation(this.page, () => this.safeClick(submit.locator), 8_000).catch(async error => {
      // The editor may save without a separate API round trip we can observe; fall back to the card check.
      if (!/waitForResponse|Timeout/i.test((error as Error).message)) throw error;
    });
    await this.settle();
    const shown = await this.waitForCard(n!, t => renderedScoreMatches(t, sets, aFirst), 10_000);
    if (renderedScoreMatches(shown, sets, aFirst)) {
      await screenshot(this.page, `${row.match_id}-score-confirmed`);
      return 'SCORE_SYNCED';
    }
    return 'NEEDS_REVIEW: UTR accepted the score but it is not shown on the match';
  }
}
