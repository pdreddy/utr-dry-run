import fs from 'node:fs';
import { CSV_COLUMNS, type MatchRow } from '../models/match.ts';

const LEGACY: Record<string, string> = { source_a: 'depends_on_a', source_b: 'depends_on_b' };

export function parseMatches(text: string): MatchRow[] {
  const matrix: string[][] = [];
  let record: string[] = [], field = '', quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted && char === '"' && source[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { record.push(field.trim()); field = ''; }
    else if (!quoted && char === '\n') { record.push(field.trim()); if (record.some(Boolean)) matrix.push(record); record = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || record.length) { record.push(field.trim()); matrix.push(record); }
  const headers = matrix.shift() ?? [];
  const records = matrix.map(values => Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ''])));
  return records.map(record => {
    const row: Record<string, string> = { ...record };
    for (const [oldKey, newKey] of Object.entries(LEGACY)) if (!row[newKey] && row[oldKey]) row[newKey] = row[oldKey];
    for (const column of CSV_COLUMNS) row[column] ??= '';
    return row as MatchRow;
  });
}

export function readMatches(file: string): MatchRow[] { return parseMatches(fs.readFileSync(file, 'utf8')); }

export function writeMatches(file: string, rows: MatchRow[]): void {
  const existing = Object.keys(rows[0] ?? {}).filter(k => !Object.keys(LEGACY).includes(k));
  const columns = [...existing, ...CSV_COLUMNS.filter(c => !existing.includes(c))];
  const tmp = `${file}.tmp`;
  const escape = (value: string) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const output = [columns, ...rows.map(row => columns.map(column => row[column] ?? ''))]
    .map(values => values.map(escape).join(',')).join('\n') + '\n';
  fs.writeFileSync(tmp, output);
  fs.renameSync(tmp, file);
}
