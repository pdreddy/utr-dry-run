import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatches } from '../src/csv/store.ts';
import { duplicateKey, parseScore, resolveBracket, validateBracket, validateWinner } from '../src/bracket/bracket.ts';
import { namesEqual } from '../src/utils/names.ts';
import type { MatchRow } from '../src/models/match.ts';
import { shouldRunHeadless } from '../src/utr/browser.ts';
import { loginTimeout } from '../src/utr/login.ts';

const csv = `match_id,round,player_a,player_b,depends_on_a,depends_on_b,winner,score,status
R1,R16,Alice Smith,Bob Jones,,,,,READY_TO_CREATE
R2,R16,Carol Doe,Dan Wu,,,,,READY_TO_CREATE
QF1,QF,,,R1,R2,,,WAITING_FOR_WINNERS\n`;
const row = (overrides: Partial<MatchRow> = {}) => ({
  match_id: 'R1', round: 'R16', player_a: 'Alice', player_b: 'Bob', depends_on_a: '', depends_on_b: '',
  match_date: '', match_time: '', winner: '', score: '', status: 'READY_TO_CREATE', utr_match_id: '',
  utr_match_url: '', utr_sync_status: '', utr_synced_at: '', ...overrides
}) as MatchRow;

describe('CSV and bracket automation', () => {
  it('parses CSV and fills optional columns', () => {
    const rows = parseMatches(csv);
    assert.equal(rows.length, 3); assert.equal(rows[0]?.utr_match_id, '');
  });
  it('detects duplicate match IDs', () => assert.match(validateBracket([row(), row()]).join(), /duplicate match_id/));
  it('resolves dependencies', () => {
    const rows = parseMatches(csv); rows[0]!.winner = 'Alice Smith'; rows[1]!.winner = 'Dan Wu';
    assert.deepEqual({ player_a: resolveBracket(rows)[2]!.player_a, player_b: rows[2]!.player_b }, { player_a: 'Alice Smith', player_b: 'Dan Wu' });
  });
  it('propagates winners through multiple rounds', () => {
    const rows = parseMatches(csv); rows.push(row({ match_id: 'SF1', round: 'SF', player_a: '', player_b: 'Eve', depends_on_a: 'QF1' }));
    rows[0]!.winner = 'Alice Smith'; rows[1]!.winner = 'Carol Doe'; rows[2]!.winner = 'Alice Smith';
    assert.equal(resolveBracket(rows)[3]!.player_a, 'Alice Smith');
  });
  it('parses straight, three-set, and match-tiebreak scores', () => {
    assert.equal(parseScore('6-4,6-3').length, 2); assert.equal(parseScore('6-4,3-6,6-2').length, 3);
    assert.deepEqual(parseScore('6-4,3-6,10-7')[2], { a: 10, b: 7 });
  });
  it('rejects a winner inconsistent with score', () => assert.throws(() => validateWinner(row({ score: '6-4,6-3', winner: 'Bob' })), /conflicts/));
  it('detects a missing player', () => assert.match(validateBracket([row({ player_a: '' })]).join(), /missing player_a/));
  it('detects duplicate players using safe normalization', () => assert.match(validateBracket([row({ player_b: ' alice\u00a0smith ', player_a: 'Alice Smith' })]).join(), /duplicate player/));
  it('builds stable idempotency keys from normalized names', () => assert.equal(duplicateKey(row({ player_a: ' ALICE  Smith ' })), duplicateKey(row({ player_a: 'alice\u00a0smith' }))));
  it('unlocks later rounds only after both winners exist', () => {
    const rows = parseMatches(csv); rows[0]!.winner = 'Alice Smith';
    assert.equal(resolveBracket(rows)[2]!.status, 'WAITING_FOR_WINNERS');
    rows[1]!.winner = 'Dan Wu'; assert.equal(resolveBracket(rows)[2]!.status, 'READY_TO_CREATE');
  });
  it('normalizes capitalization, whitespace, and Unicode spacing only', () => {
    assert.equal(namesEqual('Pranav\u00a0 V', ' pranav v '), true); assert.equal(namesEqual('Pranav V', 'Pranav Vijay'), false);
  });
  it('uses headed mode unless headless is explicitly requested', () => {
    assert.equal(shouldRunHeadless(undefined), false); assert.equal(shouldRunHeadless('false'), false);
    assert.equal(shouldRunHeadless('TRUE'), true);
  });
  it('validates the manual login timeout', () => {
    assert.equal(loginTimeout('120000'), 120_000); assert.equal(loginTimeout('bad'), 600_000);
  });
});
