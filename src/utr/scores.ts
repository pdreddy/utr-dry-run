import type { Page } from 'playwright';
import type { MatchRow } from '../models/match.ts';
import { parseScore, validateWinner } from '../bracket/bracket.ts';
import { firstVisible, screenshot } from './browser.ts';
import { SELECTORS } from './selectors.ts';

export async function prepareScore(page: Page, row: MatchRow, live: boolean): Promise<string> {
  validateWinner(row);
  if (!row.utr_match_url && !row.utr_match_id) return 'NEEDS_REVIEW: no stored UTR match reference';
  if (row.utr_sync_status === 'SCORE_SYNCED') return 'SKIP_ALREADY_EXISTS';
  if (row.utr_match_url) await page.goto(row.utr_match_url, { waitUntil: 'domcontentloaded' });
  const body = await page.locator('body').innerText();
  if (!body.toLocaleLowerCase().includes(row.player_a.toLocaleLowerCase()) || !body.toLocaleLowerCase().includes(row.player_b.toLocaleLowerCase())) return 'NEEDS_REVIEW: player verification failed';
  const open = await firstVisible(page, SELECTORS.scoreEntry);
  if (!open) return 'NEEDS_REVIEW: score control not found';
  await open.locator.click();
  const sets = parseScore(row.score);
  const fields = page.locator(SELECTORS.scoreInputs.join(','));
  if (await fields.count() < sets.length * 2) return 'NEEDS_REVIEW: UTR score format does not match CSV';
  for (let i = 0; i < sets.length; i++) {
    await fields.nth(i * 2).fill(String(sets[i]!.a));
    await fields.nth(i * 2 + 1).fill(String(sets[i]!.b));
  }
  const submit = await firstVisible(page, SELECTORS.finalScore);
  await screenshot(page, `${row.match_id}-score-before-submit`);
  if (!submit) return 'NEEDS_REVIEW: score submit control not found';
  if (!live) return 'NOT_SUBMITTED';
  await submit.locator.click();
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const confirmed = (await page.locator('body').innerText()).replace(/\s/g, '').includes(row.score.replace(/\s/g, ''));
  if (!confirmed) return 'NEEDS_REVIEW: score confirmation failed';
  await screenshot(page, `${row.match_id}-score-confirmed`);
  return 'SCORE_SYNCED';
}
