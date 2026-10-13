export const CSV_COLUMNS = [
  'match_id', 'round', 'player_a', 'player_b', 'depends_on_a', 'depends_on_b',
  'match_date', 'match_time', 'winner', 'score', 'status', 'utr_match_id',
  'utr_match_url', 'utr_sync_status', 'utr_synced_at'
] as const;

export type MatchStatus = 'READY_TO_CREATE' | 'WAITING_FOR_WINNERS' | 'COMPLETED' | 'NEEDS_REVIEW';

export interface MatchRow extends Record<string, string> {
  match_id: string; round: string; player_a: string; player_b: string;
  depends_on_a: string; depends_on_b: string; match_date: string; match_time: string;
  winner: string; score: string; status: string; utr_match_id: string;
  utr_match_url: string; utr_sync_status: string; utr_synced_at: string;
}

export interface LogEntry {
  timestamp: string; match_id?: string; round?: string; player_a?: string;
  player_b?: string; action: string; result: string; utr_match_id?: string; error?: string;
}
