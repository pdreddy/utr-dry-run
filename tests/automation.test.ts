import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatches } from '../src/csv/store.ts';
import { duplicateKey, parseScore, resolveBracket, validateBracket, validateWinner } from '../src/bracket/bracket.ts';
import { namesEqual } from '../src/utils/names.ts';
import type { MatchRow } from '../src/models/match.ts';
import { shouldRunHeadless, validatedCdpUrl } from '../src/utr/browser.ts';
import { isAuthenticationStorageKey, loginTimeout } from '../src/utr/login.ts';
import { drawEditorUrl, eventUrl } from '../src/utr/event.ts';
import { lineNamesPlayer, renderedScoreMatches, roundLabels, scoreFieldValues } from '../src/utr/eventPage.ts';
import { endpointTemplate, extractId, shapeOf } from '../src/utr/network.ts';
import { selectRows } from '../src/cli.ts';

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
  it('recognizes authentication storage names without mistaking analytics for a session', () => {
    assert.equal(isAuthenticationStorageKey('accessToken'), true);
    assert.equal(isAuthenticationStorageKey('utr_session'), true);
    assert.equal(isAuthenticationStorageKey('auth0.user'), true);
    assert.equal(isAuthenticationStorageKey('analytics_session'), false);
    assert.equal(isAuthenticationStorageKey('ajs_anonymous_id'), false);
    assert.equal(isAuthenticationStorageKey('_ga'), false);
  });
  it('only allows CDP attachment to a local browser', () => {
    assert.equal(validatedCdpUrl('http://127.0.0.1:9222'), 'http://127.0.0.1:9222/');
    assert.throws(() => validatedCdpUrl('http://example.com:9222'), /localhost/);
  });
  it('accepts only canonical UTR event URLs and preserves draw parameters', () => {
    const oldUrl = process.env.UTR_EVENT_URL, oldId = process.env.UTR_EVENT_ID;
    delete process.env.UTR_EVENT_URL; delete process.env.UTR_EVENT_ID;
    try {
      assert.equal(eventUrl({ eventUrl: 'https://app.utrsports.net/events/388079?d=draw&r=0&t=4' }), 'https://app.utrsports.net/events/388079?d=draw&r=0&t=4');
      assert.throws(() => eventUrl({ eventUrl: 'https://example.com/events/388079' }), /UTR event URL/);
    } finally {
      if (oldUrl === undefined) delete process.env.UTR_EVENT_URL; else process.env.UTR_EVENT_URL = oldUrl;
      if (oldId === undefined) delete process.env.UTR_EVENT_ID; else process.env.UTR_EVENT_ID = oldId;
    }
  });
  it('matches a player line exactly, tolerating ratings and seeds but not longer names', () => {
    assert.equal(lineNamesPlayer('Pranav V', 'Pranav V'), true);
    assert.equal(lineNamesPlayer('[1] Pranav V (8.12)', 'pranav v'), true);
    assert.equal(lineNamesPlayer('Pranav Vijay', 'Pranav V'), false);
  });
  it('recognizes a rendered score in interleaved and per-player layouts', () => {
    const sets = parseScore('6-4,3-6,10-7');
    assert.equal(renderedScoreMatches('Pranav V\n6\n3\n10\nRidit Sarkar\n4\n6\n7', sets), true);
    assert.equal(renderedScoreMatches('6-4 3-6 10-7', sets), true);
    assert.equal(renderedScoreMatches('Ridit Sarkar\n4\n6\n7\nPranav V\n6\n3\n10', sets, false), true);
    assert.equal(renderedScoreMatches('Pranav V 8.12\n6\n4', parseScore('6-3')), false);
  });
  it('maps CSV rounds to UTR round labels', () => assert.ok(roundLabels('QF').includes('Quarterfinals')));
  it('maps sets to labelled score inputs, swapping when player B is listed first', () => {
    const labels = ['Set 1 Player 1', 'Set 1 Player 2', 'Set 2 Player 1', 'Set 2 Player 2', 'Set 3 Player 1', 'Set 3 Player 2'];
    assert.deepEqual(scoreFieldValues(labels, parseScore('6-4,6-3'), true), [6, 4, 6, 3, undefined, undefined]);
    assert.deepEqual(scoreFieldValues(labels, parseScore('6-4,6-3'), false), [4, 6, 3, 6, undefined, undefined]);
    assert.deepEqual(scoreFieldValues(['', '', '', ''], parseScore('6-4,6-3'), true, 'rows'), [6, 6, 4, 3]);
  });
  it('extracts match IDs and records only payload shapes', () => {
    assert.equal(extractId({ match: { id: 42 } }), '42');
    assert.deepEqual(shapeOf({ playerAId: '7', sets: [{ a: 6 }] }), { playerAId: 'string', sets: [{ a: 'number' }] });
    assert.equal(endpointTemplate('https://api.utrsports.net/v1/match/123/score?x=1'), 'https://api.utrsports.net/v1/match/{id}/score');
  });
  it('limits a live run to one match unless --all or --only is given', () => {
    const rows = resolveBracket(parseMatches(csv));
    assert.deepEqual(selectRows(rows, 'create', 'live', {}).map(r => r.match_id), ['R1']);
    assert.deepEqual(selectRows(rows, 'create', 'live', { only: 'R2' }).map(r => r.match_id), ['R2']);
    assert.equal(selectRows(rows, 'create', 'live', { all: true }).length, 2);
    assert.throws(() => selectRows(rows, 'create', 'live', { only: 'QF1' }), /not an eligible/);
  });
  it('derives the Event Desk draw editor URL from the event URL and accepts the /draws path', () => {
    const old = process.env.UTR_EVENT_URL;
    process.env.UTR_EVENT_URL = 'https://app.utrsports.net/events/388079?d=d08a5733-d994&r=0&t=4';
    try {
      assert.equal(drawEditorUrl(), 'https://app.utrsports.net/events/388079/draws?v=drawEditor&d=d08a5733-d994');
      process.env.UTR_EVENT_URL = 'https://app.utrsports.net/events/388079/draws?v=drawEditor&d=x';
      assert.equal(eventUrl(), 'https://app.utrsports.net/events/388079/draws?v=drawEditor&d=x');
    } finally { if (old === undefined) delete process.env.UTR_EVENT_URL; else process.env.UTR_EVENT_URL = old; }
  });
});
