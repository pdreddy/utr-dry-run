/**
 * group-draws against the local Event Desk Players tab mock: real CLI, real Chromium.
 *
 *   node --experimental-strip-types --test tests/e2e/utr-group-draws.e2e.ts
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GROUPS_EVENT_NAME, startMockGroups, type GroupsDraw } from '../mock-utr/groups.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli.ts');
const BUNDLED_CHROMIUM = '/opt/pw-browsers/chromium';
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'groups.json'), 'utf8'));

let mock: Awaited<ReturnType<typeof startMockGroups>>;
let work: string;
let existing: GroupsDraw[];

function config(changes: Record<string, unknown> = {}): Record<string, string> {
  const file = path.join(work, `groups-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...REAL, eventUrl: mock.eventUrl, ...changes }));
  return { UTR_GROUPS_CONFIG: file };
}
const renamed = REAL.groups.map((g: { name: string; players: string[] }) => ({ ...g, name: g.name === 'Group A' ? 'Group A (Ladder)' : g.name }));

function cli(args: string[], overrides: Record<string, string>): Promise<{ code: number; out: string }> {
  const env = {
    ...process.env, UTR_EVENT_URL: mock.eventUrl, UTR_EVENT_ID: '', UTR_EVENT_NAME: GROUPS_EVENT_NAME, UTR_HEADLESS: 'true',
    UTR_CONFIG: path.join(work, 'none.json'), UTR_CDP_URL: '', UTR_PROFILE_DIR: path.join(work, 'profile'),
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

const unchanged = () => assert.deepEqual(mock.state.draws.slice(0, existing.length), existing, 'the automated Group A and its subgroups are untouched');

describe('group-draws: four ad-hoc draws from the Players tab', { timeout: 1_500_000 }, () => {
  before(async () => {
    mock = await startMockGroups();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'utr-groups-e2e-'));
    existing = structuredClone(mock.state.draws);
  });
  after(async () => { await mock.close(); fs.rmSync(work, { recursive: true, force: true }); });

  it('a doubles division is refused before the browser opens', async () => {
    const { code, out } = await cli(['group-draws', '--browser-dry-run'], config({ division: "Men's Open Doubles Ladder" }));
    assert.equal(code, 2, out);
    assert.match(out, /STOPPED before opening UTR: .*doubles division/);
  });

  it('stops when the event title is not the expected one', async () => {
    const { code, out } = await cli(['group-draws', '--live'], config({ eventName: 'Prosper Premier Racquet Club Open' }));
    assert.equal(code, 2, out);
    assert.match(out, /STOPPED: the event is "Prosper Premier Racquet Club Verified Tournament", not "Prosper Premier Racquet Club Open"/);
    assert.deepEqual(mock.state.writes, []);
  });

  it('stops when the division is not offered, listing the divisions', async () => {
    const { code, out } = await cli(['group-draws', '--live'], config({ division: "Men's Open Singles Ladder 2" }));
    assert.equal(code, 2, out);
    assert.match(out, /division "Men's Open Singles Ladder 2" is not offered \(divisions: All Divisions, Men’s Open Singles Ladder, Men’s Open Doubles Ladder, Co-ed Level-based Singles\)/);
    assert.deepEqual(mock.state.writes, []);
  });

  it('stops before creating anything when a player is missing or ambiguous, naming them', async () => {
    const groups = structuredClone(renamed);
    groups[1].players[7] = 'Ravi Kumar';      // two singles players share this name
    groups[3].players[0] = 'Nobody Here';     // not in the division
    const { code, out } = await cli(['group-draws', '--live'], config({ groups }));
    assert.equal(code, 2, out);
    assert.match(out, /Ravi Kumar \(Group B\): 2 players with this name/);
    assert.match(out, /Nobody Here \(Group D\): not in this division/);
    assert.match(out, /GROUPS players matched: 62 of 64/);
    assert.deepEqual(mock.state.writes, []);
    unchanged();
  });

  let liveConfig: Record<string, string>;

  it('dry run: "Group A" is taken, so that group would be "Group AA"; each form is filled and cancelled, nothing created', async () => {
    const env = config();
    const { code, out } = await cli(['group-draws', '--browser-dry-run'], env);
    assert.equal(code, 0, out);
    assert.match(out, /GROUPS players matched: 64 of 64/, 'Uma Vommi and Brian Chong also play doubles; only the singles division counts');
    assert.match(out, /"Group A" already exists; this group will be named "Group AA"/);
    assert.equal(out.match(/^ {2}.+: NOT_SUBMITTED$/gm)?.length, 4, out); // report lines
    assert.match(out, /^ {2}Group AA \(listed as "Group A", a name already taken\): NOT_SUBMITTED$/m);
    assert.match(out, /Draw type: "Ad-hoc"/);
    assert.match(out, /Format: "Best of 3 sets"/);
    assert.deepEqual(mock.state.writes, []);
    assert.ok(!fs.readFileSync(env.UTR_GROUPS_CONFIG!, 'utf8').includes('createdAs'), 'a dry run records nothing');
    unchanged();
  });

  it('live creates "Group AA", B, C and D, each with exactly its 16 players, Ad-Hoc, Best of 3 Sets', async () => {
    liveConfig = config();
    const { code, out } = await cli(['group-draws', '--live'], liveConfig);
    assert.equal(code, 0, out);
    assert.equal(out.match(/^ {2}.+: CREATED {2}/gm)?.length, 4, out); // report lines
    assert.match(out, /Unmatched players: none/);
    assert.match(out, /Scores entered: none/);
    assert.match(out, /still listed unchanged: yes/);
    const made = mock.state.draws.slice(existing.length);
    assert.deepEqual(made.map(d => d.name), ['Group AA', 'Group B', 'Group C', 'Group D']);
    for (const [i, draw] of made.entries()) {
      assert.equal(draw.drawType, 'Ad-Hoc');
      assert.equal(draw.format, 'Best of 3 Sets');
      assert.deepEqual(draw.players.map(p => mock.state.players[p]!.name).sort(), [...REAL.groups[i].players].sort());
      assert.ok(draw.players.every(p => mock.state.players[p]!.division.includes('Singles')), 'singles players only');
      assert.match(out, new RegExp(`${draw.name}( \\(listed as "Group A", a name already taken\\))?: CREATED  http://127\\.0\\.0\\.1:\\d+/events/500001/draws\\?v=drawEditor&d=${draw.id}  \\(16 players\\)`));
    }
    const saved = JSON.parse(fs.readFileSync(liveConfig.UTR_GROUPS_CONFIG!, 'utf8'));
    assert.deepEqual(saved.groups.map((g: { createdAs: string }) => g.createdAs), ['Group AA', 'Group B', 'Group C', 'Group D']);
    unchanged();
  });

  it('re-running skips the four created groups and makes nothing twice', async () => {
    const count = mock.state.draws.length;
    const { code, out } = await cli(['group-draws', '--live'], liveConfig);
    assert.equal(code, 0, out);
    assert.equal(out.match(/: SKIP_ALREADY_CREATED/g)?.length, 4, out);
    assert.equal(mock.state.draws.length, count);
  });
});
