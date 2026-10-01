#!/usr/bin/env bash
# One-stop runner for the UTR tournament automation (macOS/Linux).
# Usage: ./run.sh <command> [extra args]      e.g. ./run.sh dry-run
set -euo pipefail
cd "$(dirname "$0")"

CSV="${CSV:-matches.csv}"
utr() { npm run --silent utr -- "$@"; }

need_env() {
  [ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
}

usage() {
  cat <<EOF
Usage: ./run.sh <command> [extra args]

  setup            Install dependencies and the Chromium browser (run once)
  check            Validate matches.csv and print the plan (no browser)
  login            Open the browser so YOU can log in to UTR (credentials are never typed into this tool)
  dry-run          Browser dry run for creating matches: fills forms, submits nothing, keeps window open
  create-one       LIVE: create exactly one match (default R16-1, or: ./run.sh create-one R16-2)
  create-all       LIVE: create every ready match (run only after create-one looked right in UTR)
  scores-dry-run   Browser dry run for score entry: fills scores, submits nothing
  scores           LIVE: enter all scores recorded in matches.csv
  sync             LIVE: enter scores AND create the next round's matches
  capture          Record UTR's own web calls while you do one match + one score by hand
  test             Unit tests + typecheck
  test-e2e         Full 15-match event against the local UTR mock

Set CSV=other.csv to use a different file. Extra args are passed through (e.g. --keep-open).
Typical order: setup -> check -> dry-run -> create-one -> create-all -> (after play) sync
EOF
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  setup)  npm install && npx playwright install chromium; need_env ;;
  check)  utr validate "$CSV" && utr plan "$CSV" ;;
  login|dry-run)
          need_env
          echo "A browser window will open. Log in to UTR yourself (including any MFA), then leave it open."
          UTR_HEADLESS=false utr create "$CSV" --browser-dry-run --keep-open "$@" ;;
  create-one)
          need_env; id="${1:-R16-1}"; [ $# -gt 0 ] && shift
          utr create "$CSV" --live --only "$id" "$@" ;;
  create-all)      need_env; utr create "$CSV" --live --all "$@" ;;
  scores-dry-run)  need_env; utr scores "$CSV" --browser-dry-run --keep-open "$@" ;;
  scores)          need_env; utr scores "$CSV" --live --all "$@" ;;
  sync)            need_env; utr sync "$CSV" --live --all "$@" ;;
  capture)         need_env; UTR_HEADLESS=false utr capture "$CSV" "$@" ;;
  test)            npm test && npx tsc --noEmit -p . ;;
  test-e2e)        npm run test:e2e ;;
  help|-h|--help)  usage ;;
  *) echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
esac
