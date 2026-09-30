import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../models/match.ts';

export class Logger {
  private entries: LogEntry[] = [];
  private readonly textFile: string;
  private readonly jsonFile: string;
  constructor(dir = process.env.UTR_LOG_DIR || 'logs', now = new Date()) {
    fs.mkdirSync(dir, { recursive: true });
    const day = now.toISOString().slice(0, 10);
    this.textFile = path.join(dir, `utr-sync-${day}.log`);
    this.jsonFile = path.join(dir, `utr-sync-${day}.json`);
  }
  log(entry: Omit<LogEntry, 'timestamp'>): void {
    const full = { timestamp: new Date().toISOString(), ...entry };
    this.entries.push(full);
    const safe = { ...full, error: full.error?.replace(/(token|password|cookie)=[^\s]+/gi, '$1=[REDACTED]') };
    fs.appendFileSync(this.textFile, `${safe.timestamp} ${safe.match_id ?? '-'} ${safe.action} ${safe.result}${safe.error ? ` ${safe.error}` : ''}\n`);
    fs.writeFileSync(this.jsonFile, JSON.stringify(this.entries, null, 2));
  }
}
