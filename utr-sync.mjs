import fs from 'node:fs';
import path from 'node:path';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(v => v.trim() !== '')).map(r =>
    Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()]))
  );
}

function validate(row, index) {
  const errors = [];
  const status = row.status?.toUpperCase();
  if (!row.match_id) errors.push('missing match_id');
  if (!row.round) errors.push('missing round');
  if (!status) errors.push('missing status');

  const allowed = new Set(['CREATE', 'UPDATE_SCORE', 'WAITING']);
  if (status && !allowed.has(status)) errors.push(`invalid status ${row.status}`);

  if (status === 'CREATE' || status === 'UPDATE_SCORE') {
    if (!row.player_a) errors.push('missing player_a');
    if (!row.player_b) errors.push('missing player_b');
    if (row.player_a && row.player_b && row.player_a.toLowerCase() === row.player_b.toLowerCase()) {
      errors.push('players cannot be the same');
    }
  }

  if (status === 'UPDATE_SCORE' && !row.score) errors.push('UPDATE_SCORE requires score');
  if (status === 'WAITING') {
    if (!row.source_a) errors.push('WAITING requires source_a');
    if (!row.source_b) errors.push('WAITING requires source_b');
  }

  if (row.match_date && !/^\d{4}-\d{2}-\d{2}$/.test(row.match_date)) errors.push('match_date must be YYYY-MM-DD');
  if (row.match_time && !/^\d{2}:\d{2}$/.test(row.match_time)) errors.push('match_time must be HH:MM');
  return { row: index + 2, errors };
}

function planAction(row) {
  const status = row.status.toUpperCase();
  if (status === 'CREATE') {
    return {
      action: 'CREATE_MATCH',
      summary: `${row.player_a} vs ${row.player_b}`,
      details: `${row.round} | ${row.match_date || 'date TBD'} ${row.match_time || ''}`.trim()
    };
  }
  if (status === 'UPDATE_SCORE') {
    return {
      action: 'UPDATE_SCORE',
      summary: `${row.player_a} vs ${row.player_b}`,
      details: `${row.round} | score ${row.score}`
    };
  }
  return {
    action: 'WAIT_FOR_WINNERS',
    summary: `${row.source_a} vs ${row.source_b}`,
    details: `${row.round} | create only after both winners are known`
  };
}

async function main() {
  const args = process.argv.slice(2);
  const csvArg = args.find(a => !a.startsWith('--')) || 'matches.csv';
  const dryRun = args.includes('--dry-run');
  const file = path.resolve(process.cwd(), csvArg);
  if (!fs.existsSync(file)) {
    console.error(`CSV not found: ${file}`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  console.log(`Loaded ${rows.length} row(s) from ${file}`);

  const seen = new Set();
  let invalid = 0;
  const validRows = [];
  rows.forEach((row, i) => {
    const result = validate(row, i);
    if (seen.has(row.match_id)) result.errors.push(`duplicate match_id ${row.match_id}`);
    seen.add(row.match_id);
    if (result.errors.length) {
      invalid++;
      console.log(`\n[INVALID row ${result.row}] ${result.errors.join('; ')}`);
    } else validRows.push(row);
  });

  if (invalid) {
    console.log(`\nStopped: ${invalid} invalid row(s). No browser actions performed.`);
    process.exitCode = 2;
    return;
  }

  let actionable = 0;
  let waiting = 0;
  console.log('\nBracket plan:');
  for (const row of validRows) {
    const plan = planAction(row);
    if (row.status.toUpperCase() === 'WAITING') waiting++;
    else actionable++;
    console.log(`- ${row.match_id}: ${plan.action} | ${plan.summary} | ${plan.details}`);
  }

  if (dryRun) {
    console.log(`\nDRY RUN COMPLETE: ${actionable} actionable match(es), ${waiting} dependent match(es) waiting. Nothing was sent to UTR.`);
    return;
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto('https://app.utrsports.net/', { waitUntil: 'domcontentloaded' });
  console.log('UTR opened. Selector mapping is the next step; no matchup or score was submitted.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
