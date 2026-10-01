#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import { readMatches, writeMatches } from './csv/store.ts';
import { resolveBracket, validateBracket } from './bracket/bracket.ts';
import type { MatchRow } from './models/match.ts';
import { Logger } from './utils/logger.ts';
import { openSession } from './utr/browser.ts';
import { ensureAuthenticated } from './utr/login.ts';
import { eventUrl, openAndVerifyEvent, siteOrigin } from './utr/event.ts';
import { discoverControls } from './utr/discovery.ts';
import { UtrEventPage } from './utr/eventPage.ts';
import { recordApiCalls } from './utr/network.ts';
import { inspectPage } from './utr/inspect.ts';
import readline from 'node:readline/promises';

type ModeOptions = { dryRun?: boolean; browserDryRun?: boolean; live?: boolean; all?: boolean; keepOpen?: boolean; only?: string };
type Operation = 'create'|'scores'|'sync';

function loadDotEnv(): void {
  if (!fs.existsSync('.env')) return;
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv();

function load(file: string): { file: string; rows: MatchRow[] } {
  const absolute = path.resolve(file);
  const rows = resolveBracket(readMatches(absolute));
  const errors = validateBracket(rows);
  if (errors.length) throw new Error(`CSV validation failed:\n${errors.map(e => `- ${e}`).join('\n')}`);
  return { file: absolute, rows };
}

function requireMode(options: ModeOptions): 'dry'|'browser'|'live' {
  const selected = [options.dryRun, options.browserDryRun, options.live].filter(Boolean).length;
  if (selected !== 1) throw new Error('Choose exactly one mode: --dry-run, --browser-dry-run, or --live');
  return options.live ? 'live' : options.browserDryRun ? 'browser' : 'dry';
}

function printPlan(rows: MatchRow[]): void {
  for (const row of rows) {
    console.log(`\n${row.match_id}`);
    if (row.status === 'WAITING_FOR_WINNERS') {
      console.log(`Winner ${row.depends_on_a} vs Winner ${row.depends_on_b}`);
      console.log('STATUS: WAITING_FOR_WINNERS');
    } else {
      console.log(`${row.player_a} vs ${row.player_b}`);
      const exists = row.utr_match_id || row.utr_match_url;
      const actions = [exists ? 'SKIP_ALREADY_EXISTS' : 'CREATE_MATCH'];
      if (row.score) actions.push(row.utr_sync_status === 'SCORE_SYNCED' ? 'SCORE_ALREADY_SYNCED' : 'UPDATE_SCORE');
      console.log(`ACTION: ${actions.join(' + ')}`);
    }
  }
}

/** Live mode touches one match unless --all is given: --only <id>, else the first eligible row. */
export function selectRows(rows: MatchRow[], operation: Operation, mode: 'dry'|'browser'|'live', options: ModeOptions): MatchRow[] {
  const candidates = rows.filter(r => r.status !== 'WAITING_FOR_WINNERS' && (operation !== 'scores' || r.score));
  if (options.only) {
    const chosen = candidates.filter(r => r.match_id === options.only);
    if (!chosen.length) throw new Error(`--only ${options.only} is not an eligible match for ${operation}`);
    return chosen;
  }
  if (mode !== 'live' || options.all) return candidates;
  const pending = candidates.filter(r => operation === 'scores' ? r.utr_sync_status !== 'SCORE_SYNCED' : !(r.utr_match_id || r.utr_match_url) || (operation === 'sync' && r.score && r.utr_sync_status !== 'SCORE_SYNCED'));
  return pending.slice(0, 1);
}

async function withBrowser<T>(options: ModeOptions, work: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  const session = await openSession();
  try {
    console.log(`Opening ${siteOrigin()} ...`);
    const authenticatedPage = await ensureAuthenticated(session.page);
    console.log(`UTR LOGIN: ${authenticatedPage ? 'PASS' : 'FAIL'}`);
    if (!authenticatedPage) throw new Error('Authentication was not detected before timeout; see screenshots/authentication-timeout.png');
    session.page = authenticatedPage;
    return await work(session.page);
  } catch (error) {
    // Show the reason immediately; --keep-open would otherwise hold it back until Ctrl+C.
    console.error(`\nFAILED: ${(error as Error).message}`);
    throw error;
  } finally {
    if (options.keepOpen) {
      console.log('KEEP OPEN: Browser will remain open for inspection. Press Ctrl+C once to close it safely.');
      await new Promise<void>(resolve => {
        const finish = () => resolve();
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
      });
    }
    await session.close();
  }
}

async function browserRun(file: string, operation: Operation, options: ModeOptions): Promise<void> {
  const mode = requireMode(options);
  const { file: absolute, rows } = load(file);
  const selected = selectRows(rows, operation, mode, options);
  if (mode === 'dry') { printPlan(selected); return; }
  const logger = new Logger();
  const totals: Record<string, number> = {};
  await withBrowser(options, async page => {
    const event = await openAndVerifyEvent(page, mode === 'live');
    console.log(`UTR EVENT:\n${event.name}\n\nEVENT VERIFIED: ${event.verified ? 'YES' : 'NO'}`);
    await discoverControls(page);
    const eventPage = new UtrEventPage(page, eventUrl()!);
    if (mode === 'live' && !options.all && !options.only) console.log(`LIVE SAFETY GATE: processing ${selected.length} match(es). Confirm in UTR, then re-run with --all.`);
    for (const row of selected) {
      const results: string[] = [];
      try {
        if (operation !== 'scores') {
          // Reload for every match so an unsubmitted dry-run dialog never carries over.
          await eventPage.open();
          const prepared = await eventPage.createMatch(row, mode === 'live');
          results.push(prepared.result.startsWith('NEEDS_REVIEW') ? 'NEEDS_REVIEW' : prepared.result);
          console.log(`${row.match_id} ${row.player_a} vs ${row.player_b}: ${prepared.result}`);
          if (prepared.playerA) console.log(`  PLAYER A MATCHED: ${prepared.playerA}\n  PLAYER B MATCHED: ${prepared.playerB}`);
          if (mode === 'browser' && prepared.result === 'NOT_SUBMITTED') console.log('  FORM POPULATED, SUBMIT AVAILABLE, NOT SUBMITTED');
          if (prepared.utrMatchId) row.utr_match_id = prepared.utrMatchId;
          if (prepared.utrMatchUrl) row.utr_match_url = prepared.utrMatchUrl;
          if (prepared.result === 'CREATED') { row.utr_sync_status = 'MATCH_CREATED'; row.utr_synced_at = new Date().toISOString(); }
          if (prepared.result.startsWith('NEEDS_REVIEW')) throw new Error(prepared.result);
        }
        // A match previewed but not submitted in a browser dry run cannot be scored yet.
        if (row.score && operation !== 'create' && results[0] !== 'NOT_SUBMITTED') {
          await eventPage.open();
          const scored = await eventPage.enterScore(row, mode === 'live');
          results.push(scored.startsWith('NEEDS_REVIEW') ? 'NEEDS_REVIEW' : scored);
          console.log(`${row.match_id} score ${row.score}: ${scored}`);
          if (mode === 'live' && (scored === 'SCORE_SYNCED' || scored === 'SKIP_ALREADY_EXISTS')) { row.utr_sync_status = 'SCORE_SYNCED'; row.utr_synced_at = new Date().toISOString(); }
          if (scored.startsWith('NEEDS_REVIEW')) throw new Error(scored);
        }
      } catch (error) {
        const message = (error as Error).message.replace(/^NEEDS_REVIEW: /, '');
        if (!results.includes('NEEDS_REVIEW')) results.push('NEEDS_REVIEW');
        row.utr_sync_status = 'NEEDS_REVIEW';
        console.error(`${row.match_id} NEEDS_REVIEW: ${message}`);
        logger.log({ ...row, action: operation, result: 'NEEDS_REVIEW', error: message });
      }
      for (const result of results) { const key = result.split(':')[0]!; totals[key] = (totals[key] ?? 0) + 1; }
      if (!results.includes('NEEDS_REVIEW')) logger.log({ ...row, action: operation, result: results.join('+'), utr_match_id: row.utr_match_id || undefined });
      if (mode === 'live') writeMatches(absolute, rows);
    }
  });
  console.log(`\nSUMMARY (${mode}): ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing to do'}`);
  if (totals.NEEDS_REVIEW) process.exitCode = 2;
}

/** Records the UTR web app's own API calls while the account owner performs one create and one score by hand. */
async function capture(options: ModeOptions): Promise<void> {
  await withBrowser({ ...options, keepOpen: false }, async page => {
    const event = await openAndVerifyEvent(page, false);
    console.log(`UTR EVENT: ${event.name}`);
    const stop = recordApiCalls(page);
    console.log('CAPTURE: create one match and enter one score by hand in the browser, then press Ctrl+C here.');
    await new Promise<void>(resolve => { process.once('SIGINT', () => resolve()); process.once('SIGTERM', () => resolve()); });
    console.log(`CAPTURE SAVED: ${stop()} (endpoints and payload shapes only; no headers, cookies, or values)`);
  });
}

/** Interactive: the account owner navigates to a view, presses Enter, and the page structure is saved. */
async function inspect(options: ModeOptions): Promise<void> {
  await withBrowser({ ...options, keepOpen: false }, async page => {
    const event = await openAndVerifyEvent(page, false);
    console.log(`UTR EVENT: ${event.name}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const steps = ['matchups', 'playoff', 'match-menu', 'dialog'];
    const prompts: Record<string, string> = {
      matchups: 'Go to MATCHUPS and show a round with matches',
      playoff: 'Switch to the PLAYOFF section (open the Group/Division dropdown to its playoff option)',
      'match-menu': 'Click the three-dot menu on one playoff match so its options are showing',
      dialog: 'Open the add-match / enter-score screen if there is one (do NOT save anything)'
    };
    for (const step of steps) {
      const answer = await rl.question(`\n${prompts[step]}, then press Enter here (type "skip" to skip this step, "done" to finish)... `);
      if (answer.trim() === 'done') break;
      if (answer.trim() === 'skip') continue;
      console.log(`SAVED: ${await inspectPage(page, step)}`);
    }
    rl.close();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const file = args[1] && !args[1].startsWith('--') ? args[1] : 'matches.csv';
  if (!command || !['validate', 'plan', 'create', 'scores', 'sync', 'capture', 'inspect'].includes(command)) {
    throw new Error('Usage: npm run utr -- <validate|plan|create|scores|sync|capture|inspect> [matches.csv] [--dry-run|--browser-dry-run|--live] [--all|--only <match_id>] [--keep-open]');
  }
  if (command === 'validate') { console.log(`VALID: ${load(file).rows.length} matches`); return; }
  if (command === 'plan') { printPlan(load(file).rows); return; }
  const options: ModeOptions = {
    dryRun: args.includes('--dry-run'), browserDryRun: args.includes('--browser-dry-run'),
    live: args.includes('--live'), all: args.includes('--all'), keepOpen: args.includes('--keep-open'),
    only: args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
  };
  if (command === 'capture') { await capture(options); return; }
  if (command === 'inspect') { await inspect(options); return; }
  if (options.only !== undefined && (!options.only || options.only.startsWith('--'))) throw new Error('--only requires a match_id');
  if (options.only && options.all) throw new Error('Use either --only or --all, not both');
  await browserRun(file, command as Operation, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
