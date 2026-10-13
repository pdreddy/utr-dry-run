import type { MatchRow } from '../models/match.ts';
import { namesEqual, normalizeName } from '../utils/names.ts';

export function resolveBracket(rows: MatchRow[]): MatchRow[] {
  const byId = new Map(rows.map(row => [row.match_id, row]));
  for (let pass = 0; pass < rows.length; pass++) {
    for (const row of rows) {
      if (row.depends_on_a) row.player_a = byId.get(row.depends_on_a)?.winner || '';
      if (row.depends_on_b) row.player_b = byId.get(row.depends_on_b)?.winner || '';
      if (row.winner) row.status = 'COMPLETED';
      else if (row.depends_on_a || row.depends_on_b) row.status = row.player_a && row.player_b ? 'READY_TO_CREATE' : 'WAITING_FOR_WINNERS';
      else if (!row.status || row.status === 'CREATE') row.status = 'READY_TO_CREATE';
    }
  }
  return rows;
}

export function validateBracket(rows: MatchRow[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const allIds = new Set(rows.map(r => r.match_id));
  rows.forEach((row, index) => {
    const at = `row ${index + 2}`;
    if (!row.match_id) errors.push(`${at}: missing match_id`);
    else if (ids.has(row.match_id)) errors.push(`${at}: duplicate match_id ${row.match_id}`);
    ids.add(row.match_id);
    if (!row.round) errors.push(`${at}: missing round`);
    if (!row.depends_on_a && !row.player_a) errors.push(`${at}: missing player_a`);
    if (!row.depends_on_b && !row.player_b) errors.push(`${at}: missing player_b`);
    if (row.player_a && row.player_b && namesEqual(row.player_a, row.player_b)) errors.push(`${at}: duplicate player`);
    for (const dep of [row.depends_on_a, row.depends_on_b]) if (dep && !allIds.has(dep)) errors.push(`${at}: unknown dependency ${dep}`);
    if (row.winner && ![row.player_a, row.player_b].some(p => namesEqual(p, row.winner))) errors.push(`${at}: winner is not a player`);
    if (row.score) {
      try { validateWinner(row); } catch (error) { errors.push(`${at}: ${(error as Error).message}`); }
    }
  });
  return errors;
}

export interface SetScore { a: number; b: number }
export function parseScore(score: string): SetScore[] {
  if (!score.trim()) throw new Error('empty score');
  return score.split(',').map(raw => {
    const match = raw.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!match) throw new Error(`invalid set score ${raw.trim()}`);
    const a = Number(match[1]), b = Number(match[2]);
    if (a === b || a > 99 || b > 99) throw new Error(`invalid set score ${raw.trim()}`);
    return { a, b };
  });
}

export function validateWinner(row: MatchRow): void {
  const sets = parseScore(row.score);
  const aWins = sets.filter(s => s.a > s.b).length;
  const bWins = sets.length - aWins;
  if (aWins === bWins) throw new Error('score has no winner');
  const scoreWinner = aWins > bWins ? row.player_a : row.player_b;
  if (!row.winner) throw new Error('score requires winner');
  if (!namesEqual(scoreWinner, row.winner)) throw new Error(`winner ${row.winner} conflicts with score`);
}

export function duplicateKey(row: MatchRow): string {
  return [row.round, normalizeName(row.player_a), normalizeName(row.player_b)].join('|');
}
