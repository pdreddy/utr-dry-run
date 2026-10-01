/**
 * End-to-end rehearsal of one complete event (the 15-match draw in matches.csv)
 * against the local UTR mock: real CLI, real headless Chromium, real CSV writes.
 *
 *   npm run test:e2e
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMatches, writeMatches } from '../../src/csv/store.ts';
import { resolveBracket } from '../../src/bracket/bracket.ts';
import { EVENT_NAME, startMockUtr } from '../mock-utr/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli.ts');
const BUNDLED_CHROMIUM = '/opt/pw-browsers/chromium';

let mock: Awaited<ReturnType<typeof startMockUtr>>;
let work: string;
let csv: string;

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, UTR_EVENT_URL: mock.eventUrl, UTR_EVENT_ID: '', UTR_EVENT_NAME: EVENT_NAME, UTR_HEADLESS: 'true',
    UTR_CONFIG: path.join(work, 'none.json'), UTR_CDP_URL: '', UTR_PROFILE_DIR: path.join(work, 'profile'),
    UTR_SCREENSHOT_DIR: path.join(work, 'screenshots'), UTR_LOG_DIR: path.join(work, 'logs'),
    UTR_BROWSER_EXECUTABLE: process.env.UTR_BROWSER_EXECUTABLE ?? (fs.existsSync(BUNDLED_CHROMIUM) ? BUNDLED_CHROMIUM : ''),
    ...overrides
  };
}

/** Runs the real CLI asynchronously: the mock server shares this process's event loop. */
function cli(args: string[], overrides: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI, ...args], { cwd: work, env: env(overrides) });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (process.env.E2E_VERBOSE) console.log(`$ utr ${args.join(' ')}\n${out}`);
      resolve({ code: code ?? -1, out });
    });
  });
}

const writes = () => mock.state.writes.length;

/** Records results for a round the way a director would after play, in matches.csv. */
function recordResults(round: string): void {
  const rows = resolveBracket(readMatches(csv));
  rows.filter(r => r.round === round).forEach((row, i) => {
    const aWins = i % 2 === 0;
    row.winner = aWins ? row.player_a : row.player_b;
    row.score = aWins ? '6-4,6-3' : '6-4,3-6,7-10';
  });
  writeMatches(csv, resolveBracket(rows));
}

describe('UTR automation, one full event against the mock', { timeout: 900_000 }, () => {
  before(async () => {
    mock = await startMockUtr();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'utr-e2e-'));
    csv = path.join(work, 'matches.csv');
    fs.copyFileSync(path.join(ROOT, 'matches.csv'), csv);
  });
  after(async () => { await mock.close(); fs.rmSync(work, { recursive: true, force: true }); });

  it('dry run plans 8 creations and opens no browser', async () => {
    const { code, out } = await cli(['create', csv, '--dry-run']);
    assert.equal(code, 0, out);
    assert.equal(out.match(/ACTION: CREATE_MATCH/g)?.length, 8);
    assert.equal(writes(), 0);
  });

  it('browser dry run fills every form but submits nothing', async () => {
    const { code, out } = await cli(['create', csv, '--browser-dry-run']);
    assert.equal(code, 0, out);
    assert.match(out, /EVENT VERIFIED: YES/);
    assert.match(out, /SUMMARY \(browser\): NOT_SUBMITTED=8$/m);
    assert.match(out, /R16-1 Pranav V vs Ridit Sarkar: NOT_SUBMITTED\n {2}PLAYER A MATCHED: exact/);
    assert.equal(writes(), 0);
    assert.ok(fs.existsSync(path.join(work, 'screenshots', 'R16-1-before-submit.png')));
  });

  it('live mode without --all creates exactly one match (safety gate)', async () => {
    const { code, out } = await cli(['create', csv, '--live']);
    assert.equal(code, 0, out);
    assert.match(out, /LIVE SAFETY GATE/);
    assert.deepEqual(mock.state.matches.map(m => [m.a, m.b, m.round]), [['Pranav V', 'Ridit Sarkar', 'Round of 16']]);
    assert.equal(readMatches(csv)[0]!.utr_match_id, String(mock.state.matches[0]!.id));
  });

  it('--all creates the rest of the round and skips the existing match', async () => {
    const { code, out } = await cli(['create', csv, '--live', '--all']);
    assert.equal(code, 0, out);
    assert.match(out, /SKIP_ALREADY_EXISTS=1/);
    assert.match(out, /CREATED=7/);
    assert.equal(mock.state.matches.length, 8);
    assert.ok(readMatches(csv).slice(0, 8).every(r => r.utr_match_id && r.utr_sync_status === 'MATCH_CREATED'));
  });

  it('re-running is idempotent: no duplicate writes', async () => {
    const before = writes();
    const { code, out } = await cli(['create', csv, '--live', '--all']);
    assert.equal(code, 0, out);
    assert.equal(writes(), before);
  });

  it('enters R16 scores on the correct matches and unlocks the quarterfinals', async () => {
    recordResults('R16');
    const preview = await cli(['scores', csv, '--browser-dry-run']);
    assert.equal(preview.code, 0, preview.out);
    assert.equal(mock.state.matches.filter(m => m.score).length, 0, 'browser dry run must not save scores');
    const { code, out } = await cli(['scores', csv, '--live', '--all']);
    assert.equal(code, 0, out);
    assert.match(out, /SCORE_SYNCED=8/);
    const r16 = mock.state.matches.find(m => m.a === 'Iraj Kotru')!;
    assert.deepEqual(r16.score, { a: [6, 3, 7], b: [4, 6, 10] }, 'R16-2 was won by player B in a match tiebreak');
    const rows = resolveBracket(readMatches(csv));
    assert.deepEqual(rows.filter(r => r.round === 'QF').map(r => r.status), Array(4).fill('READY_TO_CREATE'));
  });

  it('sync drives QF, SF and the final through creation and scoring', async () => {
    for (const round of ['QF', 'SF', 'F']) {
      recordResults(round);
      const { code, out } = await cli(['sync', csv, '--live', '--all']);
      assert.equal(code, 0, `${round}\n${out}`);
    }
    assert.equal(mock.state.matches.length, 15);
    assert.ok(mock.state.matches.every(m => m.score), 'every match is scored');
    const final = mock.state.matches.find(m => m.round === 'Final')!;
    const finalRow = readMatches(csv).find(r => r.match_id === 'FINAL')!;
    assert.deepEqual([final.a, final.b], [finalRow.player_a, finalRow.player_b]);
    assert.equal(finalRow.utr_sync_status, 'SCORE_SYNCED');
    // 15 creations + 15 score saves, no rejected duplicates.
    assert.equal(mock.state.writes.filter(w => w.method === 'POST').length, 15);
    assert.equal(mock.state.writes.filter(w => w.method === 'PUT').length, 15);
  });

  it('an ambiguous player name is sent for review, never guessed', async () => {
    const review = path.join(work, 'review.csv');
    fs.writeFileSync(review, 'match_id,round,player_a,player_b\nX1,R16,Aarav Shah,Ridit Sarkar\n');
    const before = writes();
    const { code, out } = await cli(['create', review, '--live', '--all']);
    assert.equal(code, 2, out);
    assert.match(out, /X1 NEEDS_REVIEW: player A ambiguous/);
    assert.equal(writes(), before);
    assert.equal(readMatches(review)[0]!.utr_sync_status, 'NEEDS_REVIEW');
  });

  it('live mode refuses an event whose name does not match', async () => {
    const before = writes();
    const { code, out } = await cli(['create', csv, '--live', '--all'], { UTR_EVENT_NAME: 'Some Other Open' });
    assert.equal(code, 1, out);
    assert.match(out, /Live mode requires UTR_EVENT_NAME/);
    assert.equal(writes(), before);
  });
});
