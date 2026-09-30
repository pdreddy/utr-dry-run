import type { Page } from 'playwright';
import type { MatchRow } from '../models/match.ts';
import { namesEqual } from '../utils/names.ts';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';

export async function matchAlreadyExists(page: Page, row: MatchRow): Promise<boolean> {
  if (row.utr_match_url || row.utr_match_id) return true;
  const body = (await page.locator('body').innerText().catch(() => '')).toLocaleLowerCase();
  return body.includes(row.player_a.toLocaleLowerCase()) && body.includes(row.player_b.toLocaleLowerCase()) && body.includes(row.round.toLocaleLowerCase());
}

async function selectUniquePlayer(page: Page, input: ReturnType<Page['locator']>, name: string): Promise<'exact'|'normalized'|'ambiguous'|'missing'> {
  await input.fill(name);
  const options = page.getByRole('option');
  await options.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
  const texts = await options.allTextContents();
  const indexes = texts.map((text, i) => namesEqual(text.split('\n')[0] ?? text, name) ? i : -1).filter(i => i >= 0);
  if (indexes.length > 1) return 'ambiguous';
  if (!indexes.length) return 'missing';
  const text = texts[indexes[0]!]!.split('\n')[0] ?? '';
  await options.nth(indexes[0]!).click();
  return text.trim() === name.trim() ? 'exact' : 'normalized';
}

export interface PrepareResult { result: string; playerA?: string; playerB?: string; submitAvailable?: boolean; utrMatchId?: string; utrMatchUrl?: string }

export async function prepareMatch(page: Page, row: MatchRow, live: boolean): Promise<PrepareResult> {
  if (await matchAlreadyExists(page, row)) return { result: 'SKIP_ALREADY_EXISTS' };
  const desk = await firstVisible(page, SELECTORS.eventDesk);
  if (desk) await desk.locator.click();
  const create = await firstVisible(page, SELECTORS.createMatch);
  if (!create) return { result: 'NEEDS_REVIEW: create-match control not found' };
  await create.locator.click();
  const inputs = page.locator('input[placeholder*="player" i], input[aria-label*="player" i]');
  const aInput = (await firstVisible(page, SELECTORS.playerA))?.locator ?? inputs.nth(0);
  const bInput = (await firstVisible(page, SELECTORS.playerB))?.locator ?? inputs.nth(1);
  if (!await aInput.isVisible().catch(() => false) || !await bInput.isVisible().catch(() => false)) return { result: 'NEEDS_REVIEW: player controls not found' };
  const playerA = await selectUniquePlayer(page, aInput, row.player_a);
  const playerB = await selectUniquePlayer(page, bInput, row.player_b);
  if (playerA === 'missing' || playerA === 'ambiguous' || playerB === 'missing' || playerB === 'ambiguous') return { result: 'NEEDS_REVIEW', playerA, playerB };
  const round = await firstVisible(page, SELECTORS.round);
  if (round) await round.locator.fill(row.round).catch(() => round.locator.selectOption({ label: row.round }).catch(() => undefined));
  const submit = await firstVisible(page, SELECTORS.finalCreate);
  await screenshot(page, `${row.match_id}-before-submit`);
  if (!submit) return { result: 'NEEDS_REVIEW: submit control not found', playerA, playerB, submitAvailable: false };
  if (!live) return { result: 'NOT_SUBMITTED', playerA, playerB, submitAvailable: true };
  await submit.locator.click();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const url = page.url();
  const id = url.match(/matches?\/([^/?#]+)/i)?.[1];
  await screenshot(page, `${row.match_id}-created`);
  return { result: 'CREATED', playerA, playerB, submitAvailable: true, utrMatchId: id, utrMatchUrl: url };
}
