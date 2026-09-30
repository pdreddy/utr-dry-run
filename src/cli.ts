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
import { eventUrl, openAndVerifyEvent } from './utr/event.ts';
import { discoverControls } from './utr/discovery.ts';
import { prepareMatch } from './utr/matches.ts';
import { prepareScore } from './utr/scores.ts';

type ModeOptions = { dryRun?: boolean; browserDryRun?: boolean; live?: boolean; all?: boolean; keepOpen?: boolean };

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
      console.log(row.score ? 'ACTION: UPDATE_SCORE' : row.utr_match_id || row.utr_match_url ? 'ACTION: SKIP_ALREADY_EXISTS' : 'ACTION: CREATE_MATCH');
    }
  }
}

async function browserRun(file: string, operation: 'create'|'scores'|'sync', options: ModeOptions): Promise<void> {
  const mode = requireMode(options);
  const { file: absolute, rows } = load(file);
  if (mode === 'dry') { printPlan(operation === 'scores' ? rows.filter(r => r.score) : rows); return; }
  const logger = new Logger();
  const session = await openSession();
  try {
    const authenticatedPage = await ensureAuthenticated(session.page);
    console.log(`UTR LOGIN: ${authenticatedPage ? 'PASS' : 'FAIL'}`);
    if (!authenticatedPage) throw new Error('Authentication was not detected before timeout; see screenshots/authentication-timeout.png');
    session.page = authenticatedPage;
    const event = await openAndVerifyEvent(session.page, mode === 'live');
    console.log(`UTR EVENT:\n${event.name}\n\nEVENT VERIFIED: ${event.verified ? 'YES' : 'NO'}`);
    await discoverControls(session.page);
    const candidates = rows.filter(r => r.status !== 'WAITING_FOR_WINNERS' && (operation !== 'scores' || r.score));
    const limited = mode === 'live' && operation !== 'scores' && !options.all ? candidates.filter(r => r.match_id === 'R16-1').slice(0, 1) : candidates;
    for (const row of limited) {
      let result: string;
      try {
        if (operation === 'scores' || (operation === 'sync' && row.score)) {
          result = await prepareScore(session.page, row, mode === 'live');
          if (result === 'SCORE_SYNCED') { row.utr_sync_status = result; row.utr_synced_at = new Date().toISOString(); }
        } else {
          // Reopen the verified event for every match, clearing any unsubmitted dry-run dialog.
          if (eventUrl()) await session.page.goto(eventUrl()!, { waitUntil: 'domcontentloaded' });
          const prepared = await prepareMatch(session.page, row, mode === 'live');
          result = prepared.result;
          console.log(`${row.match_id} ${result}`);
          console.log(`PLAYER A MATCHED: ${prepared.playerA ?? 'not checked'}`);
          console.log(`PLAYER B MATCHED: ${prepared.playerB ?? 'not checked'}`);
          if (prepared.playerA && prepared.playerB) console.log('FORM POPULATED');
          console.log(`SUBMIT AVAILABLE: ${prepared.submitAvailable ? 'YES' : 'NO'}`);
          if (mode === 'browser') console.log('NOT SUBMITTED');
          if (prepared.utrMatchId) row.utr_match_id = prepared.utrMatchId;
          if (prepared.utrMatchUrl) row.utr_match_url = prepared.utrMatchUrl;
          if (result === 'CREATED') { row.utr_sync_status = 'MATCH_CREATED'; row.utr_synced_at = new Date().toISOString(); }
        }
      } catch (error) {
        result = 'NEEDS_REVIEW';
        row.utr_sync_status = result;
        logger.log({ ...row, action: operation, result, error: (error as Error).message });
        console.error(`${row.match_id} NEEDS_REVIEW: ${(error as Error).message}`);
        if (mode === 'live') writeMatches(absolute, rows);
        continue;
      }
      logger.log({ ...row, action: operation, result, utr_match_id: row.utr_match_id || undefined });
      if (result.startsWith('NEEDS_REVIEW')) row.utr_sync_status = 'NEEDS_REVIEW';
      if (mode === 'live') writeMatches(absolute, rows);
      if (mode === 'live' && row.match_id === 'R16-1' && result === 'CREATED') {
        console.log(`LIVE TEST PASSED\n\nR16-1 successfully created.\nUTR match ID: ${row.utr_match_id || 'not exposed'}\nUTR URL: ${row.utr_match_url}`);
      }
    }
  } finally {
    if (options.keepOpen) {
      console.log('KEEP OPEN: Browser will remain open for inspection. Press Ctrl+C once to close it safely.');
      await new Promise<void>(resolve => {
        const finish = () => resolve();
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
      });
    }
    await session.context.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const file = args[1] && !args[1].startsWith('--') ? args[1] : 'matches.csv';
  if (!command || !['validate', 'plan', 'create', 'scores', 'sync'].includes(command)) {
    throw new Error('Usage: npm run utr -- <validate|plan|create|scores|sync> [matches.csv] [--dry-run|--browser-dry-run|--live] [--all] [--keep-open]');
  }
  if (command === 'validate') { console.log(`VALID: ${load(file).rows.length} matches`); return; }
  if (command === 'plan') { printPlan(load(file).rows); return; }
  const options: ModeOptions = {
    dryRun: args.includes('--dry-run'), browserDryRun: args.includes('--browser-dry-run'),
    live: args.includes('--live'), all: args.includes('--all'), keepOpen: args.includes('--keep-open')
  };
  await browserRun(file, command as 'create'|'scores'|'sync', options);
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
