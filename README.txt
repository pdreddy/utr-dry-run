UTR CSV Dry-Run Starter — PPRC Bracket

CSV columns:
match_id,round,player_a,player_b,source_a,source_b,match_date,match_time,score,status

Statuses:
CREATE       -> matchup is ready to create in UTR
UPDATE_SCORE -> existing matchup is ready for score update (score required)
WAITING      -> later-round matchup depends on winners from prior matches

Current bracket behavior:
- R16-1 through R16-8 are CREATE now.
- QF1-QF4, SF1-SF2 and FINAL stay WAITING.
- After an R16 score is recorded, a later resolver can replace WINNER:R16-X with the actual winner.
- A QF becomes CREATE only when both feeder winners are known.

Safe test:
  node utr-sync.mjs matches.csv --dry-run

Dry run does NOT open UTR and does NOT submit anything.
