import type { Locator, Page } from 'playwright';
import type { MatchRow } from '../models/match.ts';
import { parseScore, validateWinner, type SetScore } from '../bracket/bracket.ts';
import { normalizeName, namesEqual } from '../utils/names.ts';
import { firstVisible, screenshot } from './browser.ts';
import { clickAndAwaitMutation } from './network.ts';
import { SELECTORS } from './selectors.ts';

export interface PrepareResult { result: string; playerA?: string; playerB?: string; submitAvailable?: boolean; utrMatchId?: string; utrMatchUrl?: string }

/** True when a rendered line names the player, allowing a trailing rating or a leading seed. */
export function lineNamesPlayer(line: string, name: string): boolean {
  const cleaned = normalizeName(line).replace(/^(\[\d+\]|\(\d+\)|\d+\.)\s*/, '');
  const target = normalizeName(name);
  if (!target) return false;
  // "Pranav V (8.12)" names Pranav V; "Pranav Vijay" does not.
  return cleaned === target || (cleaned.startsWith(target) && !/^\p{L}/u.test(cleaned.slice(target.length)));
}

/** Index of the first line naming `name`, or -1. */
export function playerLine(text: string, name: string): number {
  return text.split(/\n+/).findIndex(line => lineNamesPlayer(line, name));
}

/**
 * Whether a match card's text shows the score. Accepts both interleaved
 * (6 4 6 3) and per-player row (6 6 / 4 3) layouts. Decimal ratings are ignored.
 */
export function renderedScoreMatches(text: string, sets: SetScore[], aFirst = true): boolean {
  const digits = [...text.matchAll(/(?<![\d.])\d{1,2}(?![\d.])/g)].map(m => Number(m[0]));
  const top = sets.map(s => aFirst ? s.a : s.b), bottom = sets.map(s => aFirst ? s.b : s.a);
  const interleaved = top.flatMap((t, i) => [t, bottom[i]!]);
  const rows = [...top, ...bottom];
  const contains = (needle: number[]) => digits.some((_, i) => needle.every((n, j) => digits[i + j] === n));
  return contains(interleaved) || contains(rows);
}

/** UTR draws label rounds in words; accept the CSV code or its long forms. */
export function roundLabels(round: string): string[] {
  const code = round.trim().toUpperCase();
  const known: Record<string, string[]> = {
    R128: ['Round of 128'], R64: ['Round of 64'], R32: ['Round of 32'], R16: ['Round of 16'],
    QF: ['Quarterfinal', 'Quarterfinals', 'Quarter-Final', 'Quarter Finals'],
    SF: ['Semifinal', 'Semifinals', 'Semi-Final', 'Semi Finals'],
    F: ['Final', 'Finals'], FINAL: ['Final', 'Finals']
  };
  return [round.trim(), ...(known[code] ?? [])];
}

/** Maps CSV sets to the dialog's inputs, preferring explicit "set N / player N" labels. */
export function scoreFieldValues(labels: string[], sets: SetScore[], aFirst: boolean, order = process.env.UTR_SCORE_INPUT_ORDER || 'pairs'): (number | undefined)[] {
  const top = sets.map(s => aFirst ? s.a : s.b), bottom = sets.map(s => aFirst ? s.b : s.a);
  const labelled = labels.map(label => {
    const set = label.match(/set\s*(\d)/i)?.[1];
    const player = label.match(/(?:player|p)\s*([12ab])\b/i)?.[1]?.toLowerCase();
    return set && player ? { set: Number(set) - 1, top: player === '1' || player === 'a' } : undefined;
  });
  if (labelled.every(Boolean)) return labelled.map(l => (l!.top ? top : bottom)[l!.set]);
  const perPlayer = labels.length / 2;
  return labels.map((_, i) => order === 'rows'
    ? (i < perPlayer ? top[i] : bottom[i - perPlayer])
    : (i % 2 === 0 ? top : bottom)[Math.floor(i / 2)]);
}

/** Page object for one UTR event's draw/match list. All match actions are scoped to a single card. */
export class UtrEventPage {
  readonly page: Page;
  readonly url: string;
  constructor(page: Page, url: string) { this.page = page; this.url = url; }

  async open(): Promise<void> {
    await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  }

  /** One line per text node, so adjacent inline spans (name, set scores) never merge. */
  async cardText(card: Locator): Promise<string> {
    return card.evaluate(element => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        if (text && !['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName ?? '')) parts.push(text);
      }
      return parts.join('\n');
    }).catch(() => '');
  }

  private async allCards(): Promise<Locator | undefined> {
    for (const selector of SELECTORS.matchCard) {
      const cards = this.page.locator(selector);
      if (await cards.count().catch(() => 0)) return cards;
    }
  }

  /** Cards that show both players; one is expected, more is a conflict. */
  async findMatchCards(row: MatchRow): Promise<Locator[]> {
    const cards = await this.allCards();
    if (!cards) return [];
    const found: Locator[] = [];
    for (let i = 0; i < await cards.count(); i++) {
      const text = await this.cardText(cards.nth(i));
      if (playerLine(text, row.player_a) >= 0 && playerLine(text, row.player_b) >= 0) found.push(cards.nth(i));
    }
    return found;
  }

  async matchIdentity(card: Locator): Promise<{ id?: string; url?: string }> {
    const id = await card.getAttribute('data-match-id').catch(() => null);
    const href = await card.locator('a[href*="match" i]').first().getAttribute('href', { timeout: 500 }).catch(() => null);
    const url = href ? new URL(href, this.page.url()).toString() : undefined;
    return { id: id ?? href?.match(/matches?\/([^/?#]+)/i)?.[1] ?? undefined, url };
  }

  private async dialog(): Promise<Locator | Page> {
    for (const selector of SELECTORS.dialog) {
      const candidate = this.page.locator(selector).last();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return this.page;
  }

  private async selectUniquePlayer(input: Locator, name: string): Promise<'exact'|'normalized'|'ambiguous'|'missing'> {
    await input.fill(name);
    const options = this.page.getByRole('option');
    await options.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    const texts = await options.allTextContents();
    const indexes = texts.map((text, i) => lineNamesPlayer(text.split('\n')[0] ?? text, name) ? i : -1).filter(i => i >= 0);
    if (indexes.length > 1) return 'ambiguous';
    if (!indexes.length) return 'missing';
    const text = texts[indexes[0]!]!.split('\n')[0] ?? '';
    await options.nth(indexes[0]!).click();
    return namesEqual(text, name) && text.trim() === name.trim() ? 'exact' : 'normalized';
  }

  private async chooseRound(scope: Locator | Page, round: string): Promise<void> {
    const control = await firstVisible(scope, SELECTORS.round);
    if (!control) return;
    const tag = await control.locator.evaluate(el => el.tagName).catch(() => '');
    if (tag !== 'SELECT') { await control.locator.fill(round); return; }
    const labels = (await control.locator.locator('option').allTextContents()).map(t => t.trim());
    const wanted = roundLabels(round).find(label => labels.some(l => l.toLowerCase() === label.toLowerCase()));
    if (!wanted) throw new Error(`round ${round} is not offered by UTR (${labels.join(', ')})`);
    await control.locator.selectOption({ label: labels.find(l => l.toLowerCase() === wanted.toLowerCase())! });
  }

  async createMatch(row: MatchRow, live: boolean): Promise<PrepareResult> {
    if (row.utr_match_id || row.utr_match_url) return { result: 'SKIP_ALREADY_EXISTS', utrMatchId: row.utr_match_id, utrMatchUrl: row.utr_match_url };
    const existing = await this.findMatchCards(row);
    if (existing.length > 1) return { result: 'NEEDS_REVIEW: match appears more than once in UTR' };
    if (existing.length === 1) {
      const identity = await this.matchIdentity(existing[0]!);
      return { result: 'SKIP_ALREADY_EXISTS', utrMatchId: identity.id, utrMatchUrl: identity.url };
    }
    const desk = await firstVisible(this.page, SELECTORS.eventDesk);
    if (desk) await desk.locator.click();
    const create = await firstVisible(this.page, SELECTORS.createMatch);
    if (!create) return { result: 'NEEDS_REVIEW: create-match control not found' };
    await create.locator.click();
    const scope = await this.dialog();
    const generic = scope.locator(SELECTORS.playerInputs.join(', '));
    const aInput = (await firstVisible(scope, SELECTORS.playerA))?.locator ?? (await generic.count() >= 2 ? generic.nth(0) : undefined);
    const bInput = (await firstVisible(scope, SELECTORS.playerB))?.locator ?? (await generic.count() >= 2 ? generic.nth(1) : undefined);
    if (!aInput || !bInput || !await aInput.isVisible().catch(() => false) || !await bInput.isVisible().catch(() => false)) {
      return { result: 'NEEDS_REVIEW: player controls not found' };
    }
    const playerA = await this.selectUniquePlayer(aInput, row.player_a);
    const playerB = await this.selectUniquePlayer(bInput, row.player_b);
    if (playerA === 'missing' || playerA === 'ambiguous' || playerB === 'missing' || playerB === 'ambiguous') {
      await screenshot(this.page, `${row.match_id}-player-review`);
      return { result: `NEEDS_REVIEW: player A ${playerA}, player B ${playerB}`, playerA, playerB };
    }
    await this.chooseRound(scope, row.round);
    const submit = await firstVisible(scope, SELECTORS.finalCreate);
    await screenshot(this.page, `${row.match_id}-before-submit`);
    if (!submit) return { result: 'NEEDS_REVIEW: submit control not found', playerA, playerB, submitAvailable: false };
    if (!live) return { result: 'NOT_SUBMITTED', playerA, playerB, submitAvailable: true };
    const mutation = await clickAndAwaitMutation(this.page, () => submit.locator.click());
    const card = await this.waitForCard(row);
    const identity = card ? await this.matchIdentity(card) : {};
    await screenshot(this.page, `${row.match_id}-created`);
    if (!card) return { result: 'NEEDS_REVIEW: UTR accepted the request but the match is not visible', playerA, playerB, utrMatchId: mutation.id };
    return { result: 'CREATED', playerA, playerB, submitAvailable: true, utrMatchId: identity.id ?? mutation.id, utrMatchUrl: identity.url };
  }

  /** Waits for the SPA to render the card; reloads once if it does not. */
  private async waitForCard(row: MatchRow, timeout = 10_000): Promise<Locator | undefined> {
    for (const reload of [false, true]) {
      if (reload) await this.open();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const cards = await this.findMatchCards(row);
        if (cards.length === 1) return cards[0];
        await this.page.waitForTimeout(250);
      }
    }
  }

  async enterScore(row: MatchRow, live: boolean): Promise<string> {
    validateWinner(row);
    if (row.utr_sync_status === 'SCORE_SYNCED') return 'SKIP_ALREADY_EXISTS';
    const cards = await this.findMatchCards(row);
    if (cards.length !== 1) return `NEEDS_REVIEW: expected one UTR match for ${row.player_a} vs ${row.player_b}, found ${cards.length}`;
    const card = cards[0]!;
    const text = await this.cardText(card);
    const aFirst = playerLine(text, row.player_a) < playerLine(text, row.player_b);
    const sets = parseScore(row.score);
    if (renderedScoreMatches(text, sets, aFirst)) return 'SKIP_ALREADY_EXISTS';
    const open = await firstVisible(card, SELECTORS.scoreEntry);
    if (!open) return 'NEEDS_REVIEW: score control not found on the match';
    await open.locator.click();
    const scope = await this.dialog();
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
    if (!live) return 'NOT_SUBMITTED';
    await clickAndAwaitMutation(this.page, () => submit.locator.click());
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [current] = await this.findMatchCards(row);
      if (current && renderedScoreMatches(await this.cardText(current), sets, aFirst)) {
        await screenshot(this.page, `${row.match_id}-score-confirmed`);
        return 'SCORE_SYNCED';
      }
      await this.page.waitForTimeout(250);
    }
    return 'NEEDS_REVIEW: UTR accepted the score but it is not shown on the match';
  }
}
