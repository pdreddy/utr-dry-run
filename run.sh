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

# Close any leftover automation browser still holding the saved profile (only this project's profile).
free_profile() {
  local profile="$PWD/.playwright/utr-profile"
  if pgrep -f "user-data-dir=$profile" >/dev/null 2>&1; then
    echo "Closing a leftover automation browser that is still using the saved profile..."
    pkill -f "user-data-dir=$profile" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$profile"/SingletonLock "$profile"/SingletonSocket "$profile"/SingletonCookie 2>/dev/null || true
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
  playoff          Guided: asks whether to use an existing draw or create a new one, then fills it step by step
  new-draw-dry-run Asks for the new draw's values (Enter keeps draw.json's), fills "Create draw", then CANCEL
  new-draw         LIVE: create the draw with the values saved by new-draw-dry-run (draw.json)
  reset-browser    Close a stuck automation browser (fixes "profile is already in use")
  inspect          Save the page structure of what you are looking at (to fit selectors; saves nothing in UTR)
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
  reset-browser)   free_profile; echo "Done." ;;
  new-draw-dry-run) need_env; free_profile; UTR_HEADLESS=false utr new-draw --browser-dry-run --ask --keep-open "$@" ;;
  new-draw)        need_env; free_profile; utr new-draw --live "$@" ;;
  playoff)
          need_env
          ask() { local reply; read -r -p "$1 [y/N] " reply; [[ "$reply" =~ ^[Yy] ]]; }
          read -r -p "Fill an existing draw (e) or create a new draw first (n)? [e/n] " choice
          if [[ "$choice" =~ ^[Nn] ]]; then
            free_profile; utr new-draw --browser-dry-run --ask
            name=$(node -e "console.log(JSON.parse(require('fs').readFileSync('draw.json','utf8')).name)")
            ask "The form filled correctly (see screenshots/new-draw-form.png). Create \"$name\" for real?" || exit 0
            free_profile; utr new-draw --live
          else
            read -r -p "Draw name [Playoff]: " name; name="${name:-Playoff}"
          fi
          export UTR_DRAW_NAME="$name"
          free_profile; utr create "$CSV" --browser-dry-run
          ask "All 16 players found. Add them to \"$name\" and fill Match #1 (then SAVE)?" || exit 0
          free_profile; utr create "$CSV" --live --only R16-1
          ask "Match #1 looks right in UTR. Fill Matches #2-#8 (then SAVE)?" || exit 0
          free_profile; utr create "$CSV" --live --all
          echo "Done. Check the bracket in UTR, then press PUBLISH yourself." ;;
  login|dry-run)
          need_env; free_profile
          echo "A browser window will open. Log in to UTR yourself (including any MFA), then leave it open."
          UTR_HEADLESS=false utr create "$CSV" --browser-dry-run --keep-open "$@" ;;
  create-one)
          need_env; free_profile; id="${1:-R16-1}"; [ $# -gt 0 ] && shift
          utr create "$CSV" --live --only "$id" "$@" ;;
  create-all)      need_env; free_profile; utr create "$CSV" --live --all "$@" ;;
  scores-dry-run)  need_env; free_profile; utr scores "$CSV" --browser-dry-run --keep-open "$@" ;;
  scores)          need_env; free_profile; utr scores "$CSV" --live --all "$@" ;;
  sync)            need_env; free_profile; utr sync "$CSV" --live --all "$@" ;;
  inspect)         need_env; free_profile; UTR_HEADLESS=false utr inspect "$CSV" "$@" ;;
  capture)         need_env; free_profile; UTR_HEADLESS=false utr capture "$CSV" "$@" ;;
  test)            npm test && npx tsc --noEmit -p . ;;
  test-e2e)        npm run test:e2e ;;
  help|-h|--help)  usage ;;
  *) echo "Unknown command: $cmd" >&2; usage; exit 1 ;;
esac
