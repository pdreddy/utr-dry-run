/**
 * End-to-end rehearsal against the mock Event Desk draw editor: the Playoff Round of 16.
 * Real CLI, real headless Chromium, real CSV writes. Never publishes.
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

function cli(args: string[], overrides: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const env = {
    ...process.env, UTR_EVENT_URL: mock.eventUrl, UTR_EVENT_ID: '', UTR_EVENT_NAME: EVENT_NAME, UTR_HEADLESS: 'true', UTR_TARGET: '',
    UTR_DRAW_NAME: 'Playoff', UTR_CONFIG: path.join(work, 'none.json'), UTR_CDP_URL: '', UTR_PROFILE_DIR: path.join(work, 'profile'),
    UTR_SCREENSHOT_DIR: path.join(work, 'screenshots'), UTR_LOG_DIR: path.join(work, 'logs'),
    UTR_BROWSER_EXECUTABLE: process.env.UTR_BROWSER_EXECUTABLE ?? (fs.existsSync(BUNDLED_CHROMIUM) ? BUNDLED_CHROMIUM : ''),
    ...overrides
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI, ...args], { cwd: work, env });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    child.on('error', reject);
    child.on('close', code => { if (process.env.E2E_VERBOSE) console.log(`$ utr ${args.join(' ')}\n${out}`); resolve({ code: code ?? -1, out }); });
  });
}

const writes = () => mock.state.writes.length;
const r16 = () => mock.state.editor.r16;

describe('UTR Playoff draw editor, Round of 16 against the mock', { timeout: 600_000 }, () => {
  before(async () => {
    mock = await startMockUtr();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'utr-editor-e2e-'));
    csv = path.join(work, 'matches.csv');
    fs.copyFileSync(path.join(ROOT, 'matches.csv'), csv);
  });
  after(async () => { await mock.close(); fs.rmSync(work, { recursive: true, force: true }); });

  it('browser dry run opens the dropdowns, checks every player, and changes nothing', async () => {
    const { code, out } = await cli(['create', csv, '--browser-dry-run']);
    assert.equal(code, 0, out);
    assert.match(out, /DRAW EDITOR: Single Elimination/);
    assert.match(out, /SUMMARY \(browser\): NOT_SUBMITTED=8$/m);
    assert.equal(writes(), 0);
  });

  it('live without --all fills exactly Match #1 (safety gate)', async () => {
    const { code, out } = await cli(['create', csv, '--live']);
    assert.equal(code, 0, out);
    assert.deepEqual([r16()[0]!.a, r16()[0]!.b], ['Pranav V', 'Ridit Sarkar']);
    assert.ok(r16().slice(1).every(m => !m.a && !m.b));
    assert.equal(readMatches(csv)[0]!.utr_sync_status, 'MATCH_CREATED');
  });

  it('--all fills the other seven matches in the right slots, skipping Match #1', async () => {
    const { code, out } = await cli(['create', csv, '--live', '--all']);
    assert.equal(code, 0, out);
    assert.match(out, /SKIP_ALREADY_EXISTS=1/);
    assert.match(out, /CREATED=7/);
    const expected = readMatches(csv).filter(r => r.round === 'R16').map(r => [r.player_a, r.player_b]);
    assert.deepEqual(r16().map(m => [m.a, m.b]), expected);
  });

  it('re-running is idempotent', async () => {
    const before = writes();
    const { code, out } = await cli(['create', csv, '--live', '--all']);
    assert.equal(code, 0, out);
    assert.equal(writes(), before);
  });

  it('enters Round of 16 scores on the right matches; winners advance to the quarterfinal cards', async () => {
    const rows = resolveBracket(readMatches(csv));
    rows.filter(r => r.round === 'R16').forEach((row, i) => {
      row.winner = i % 2 === 0 ? row.player_a : row.player_b;
      row.score = i % 2 === 0 ? '6-4,6-3' : '6-4,3-6,7-10';
    });
    writeMatches(csv, resolveBracket(rows));
    const preview = await cli(['scores', csv, '--browser-dry-run']);
    assert.equal(preview.code, 0, preview.out);
    assert.ok(r16().every(m => !m.score), 'dry run must not save scores');
    const { code, out } = await cli(['scores', csv, '--live', '--all']);
    assert.equal(code, 0, out);
    assert.match(out, /SCORE_SYNCED=8/);
    assert.deepEqual(r16()[0]!.score, { a: [6, 6], b: [4, 3] });
    assert.deepEqual(r16()[1]!.score, { a: [6, 3, 7], b: [4, 6, 10] }, 'player B won in a match tiebreak');
  });

  it('never presses PUBLISH', () => {
    assert.equal(mock.state.editor.published, false);
    assert.equal(mock.state.writes.filter(w => w.path.includes('publish')).length, 0);
  });

  it('an ambiguous player name goes to review without writing', async () => {
    const review = path.join(work, 'review.csv');
    fs.writeFileSync(review, 'match_id,round,player_a,player_b\nR16-1,R16,Aarav Shah,Ridit Sarkar\n');
    mock.state.editor.r16.forEach(m => { delete m.a; delete m.b; delete m.score; });
    const before = writes();
    const { code, out } = await cli(['create', review, '--live', '--all']);
    assert.equal(code, 2, out);
    assert.match(out, /NEEDS_REVIEW: player A ambiguous/);
    assert.equal(writes(), before);
  });

  it('refuses to type into a slot that already holds different players', async () => {
    mock.state.editor.r16[0] = { a: 'Aarav Shah', b: 'Viswesh Vasu' };
    const review = path.join(work, 'occupied.csv');
    fs.writeFileSync(review, 'match_id,round,player_a,player_b\nR16-1,R16,Pranav V,Ridit Sarkar\n');
    const before = writes();
    const { code, out } = await cli(['create', review, '--live', '--all']);
    assert.equal(code, 2, out);
    assert.match(out, /already has different players/);
    assert.equal(writes(), before);
  });
});
