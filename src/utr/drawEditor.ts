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

/**
 * Page object for UTR's Event Desk draw editor (`/events/<id>/draws?v=drawEditor&d=<draw>`).
 *
 * Two rounds are shown side by side, so "Match #1" appears in both columns. The
 * leftmost column is the round selected in the header, and every action is scoped
 * to the single card that holds that match's header.
 *
 * The editor autosaves; PUBLISH is a separate button. This class never clicks
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
    if (await this.page.getByText(/^Round of 16/).first().isVisible().catch(() => false)) return;
    const candidates = this.page.getByText(name, { exact: true });
    let best: Locator | undefined, bestX = Infinity;
    for (let i = 0; i < await candidates.count(); i++) {
      const item = candidates.nth(i);
      const box = await item.boundingBox().catch(() => null);
      if (box && await item.isVisible().catch(() => false) && box.x < bestX) { best = item; bestX = box.x; }
    }
    if (!best) throw new Error(`Draw "${name}" was not found in the editor's draw list`);
    await this.safeClick(best);
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await this.page.getByText(/^Round of 16/).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
  }

  /** Throws unless the page looks like the expected single-elimination draw. */
  async verifyDraw(expected = process.env.UTR_DRAW_NAME || 'Playoff'): Promise<string> {
    const text = await this.page.locator('body').innerText();
    if (!/Round of 16/i.test(text)) throw new Error('This is not the Round of 16 bracket; check the draw id in utr.config.json');
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

  /** Waits for UTR's autosave indicator to settle after an edit. */
  private async waitForSaved(): Promise<void> {
    await this.page.getByText('Saved', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    await this.page.waitForTimeout(500);
  }

  /**
   * Opens the first empty slot in the card. Returns the dropdown's option texts and a
   * way to click one. Custom dropdowns differ, so ARIA options are tried first, then
   * list items, but only items near the clicked slot (the sidebar also lists players).
   */
  private async openFirstEmptySlot(card: Locator): Promise<{ texts: string[]; choose: (index: number) => Promise<void> }> {
    const native = card.locator('select').first();
    if (await native.count() && await native.isVisible().catch(() => false)) {
      const texts = (await native.locator('option').allTextContents()).map(t => t.trim());
      return { texts, choose: async index => { await native.selectOption({ index }); } };
    }
    const slot = card.getByText(EDITOR.emptySlot, { exact: true }).first();
    const slotBox = await slot.boundingBox();
    await this.safeClick(slot);
    await this.page.waitForTimeout(400);
    const aria = this.page.getByRole('option');
    const candidates = await aria.count() ? aria : this.page.locator('[role="listbox"] li:visible, ul li:visible, [class*="option" i]:visible');
    const kept: Locator[] = [];
    const total = Math.min(await candidates.count(), 300);
    for (let i = 0; i < total; i++) {
      const item = candidates.nth(i);
      const box = await item.boundingBox().catch(() => null);
      const near = !slotBox || (box && box.y >= slotBox.y - 5 && box.y < slotBox.y + 800 && Math.abs(box.x - slotBox.x) < 400);
      if (near) kept.push(item);
    }
    const texts = await Promise.all(kept.map(async item => ((await item.innerText().catch(() => '')) || '').trim()));
    return { texts, choose: async index => { await this.safeClick(kept[index]!); } };
  }

  private async fillSlot(card: Locator, name: string): Promise<'exact'|'normalized'|'ambiguous'|'missing'> {
    const { texts, choose } = await this.openFirstEmptySlot(card);
    const matches = texts.map((t, i) => lineNamesPlayer(t.split('\n')[0] ?? t, name) ? i : -1).filter(i => i >= 0);
    if (matches.length > 1) { await this.page.keyboard.press('Escape'); return 'ambiguous'; }
    if (!matches.length) { await this.page.keyboard.press('Escape'); return 'missing'; }
    const chosen = texts[matches[0]!]!;
    await choose(matches[0]!);
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
      // Dry run: look at the options but select nothing.
      const { texts } = await this.openFirstEmptySlot(card);
      await this.page.keyboard.press('Escape');
      const find = (name: string) => texts.filter(t => lineNamesPlayer(t.split('\n')[0] ?? t, name)).length;
      const a = find(row.player_a), b = find(row.player_b);
      await screenshot(this.page, `${row.match_id}-before-submit`);
      const state = (c: number) => c === 1 ? 'exact' : c === 0 ? 'missing' : 'ambiguous';
      if (a !== 1 || b !== 1) return { result: `NEEDS_REVIEW: player A ${state(a)}, player B ${state(b)}`, playerA: state(a), playerB: state(b) };
      return { result: 'NOT_SUBMITTED', playerA: state(a), playerB: state(b), submitAvailable: true };
    }
    let a = 'exact', b = 'exact';
    if (!hasA) {
      a = await this.fillSlot(card, row.player_a);
      if (a === 'missing' || a === 'ambiguous') return { result: `NEEDS_REVIEW: player A ${a}`, playerA: a };
      await this.waitForSaved();
    }
    if (!hasB) {
      await this.ensureDraw();
      const fresh = (await this.matchCard(n))!;
      b = await this.fillSlot(fresh, row.player_b);
      if (b === 'missing' || b === 'ambiguous') return { result: `NEEDS_REVIEW: player B ${b}`, playerA: a, playerB: b };
      await this.waitForSaved();
    }
    await this.open();
    const confirmed = await this.matchCard(n);
    const after = confirmed ? await this.cardText(confirmed) : '';
    await screenshot(this.page, `${row.match_id}-created`);
    if (playerLine(after, row.player_a) < 0 || playerLine(after, row.player_b) < 0) {
      return { result: 'NEEDS_REVIEW: players are not shown in the bracket after saving', playerA: a, playerB: b };
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
    await this.waitForSaved();
    await this.open();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const fresh = n ? await this.matchCard(n) : undefined;
      if (fresh && renderedScoreMatches(await this.cardText(fresh), sets, aFirst)) {
        await screenshot(this.page, `${row.match_id}-score-confirmed`);
        return 'SCORE_SYNCED';
      }
      await this.page.waitForTimeout(300);
    }
    return 'NEEDS_REVIEW: UTR accepted the score but it is not shown on the match';
  }
}
