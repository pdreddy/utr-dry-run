# UTR tournament automation

CSV-driven, idempotent Playwright automation for creating UTR matches and entering scores. The tool keeps `matches.csv` as the source of truth, resolves bracket winners, reuses a local browser profile, and will **never submit** unless `--live` is explicitly supplied.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

The supplied draw URL is stored in `utr.config.json`. `UTR_EVENT_URL` or `UTR_EVENT_ID` can override it, and live mode additionally requires the exact `UTR_EVENT_NAME` in `.env` or `eventName` in the config. Credentials do not belong in either file: on the first headed run, log in normally in Chrome and complete any legitimate MFA/CAPTCHA. The authenticated session is retained in `.playwright/utr-profile/`. Do not commit that directory.

Leave `UTR_HEADLESS=false` for the first run. Headed mode is not inferred from `$DISPLAY` because Windows and macOS normally do not define it. The browser remains open for up to ten minutes (configurable with `UTR_LOGIN_TIMEOUT_MS`) so the account owner can complete legitimate login/MFA. Set `UTR_HEADLESS=true` only after the persistent profile has been authenticated.

The tool never accepts, retrieves, or stores a UTR password. If the Playwright profile cannot complete login, it can instead attach to a Chrome instance that **you** opened and authenticated. Close all Chrome windows, start Chrome with a dedicated temporary profile and localhost-only debugging, log into UTR normally, then set `UTR_CDP_URL=http://127.0.0.1:9222`:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$HOME/.utr-chrome"
# Windows PowerShell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$env:USERPROFILE\.utr-chrome"
# Linux
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="$HOME/.utr-chrome"
```

Use a dedicated profile rather than Chrome's normal profile. The connection is rejected unless it targets localhost, and the CLI will not close an externally managed Chrome instance.

## Commands and safety modes

```bash
npm run utr -- validate matches.csv
npm run utr -- plan matches.csv
npm run utr -- create matches.csv --dry-run
npm run utr -- create matches.csv --browser-dry-run
npm run utr -- create matches.csv --live
npm run utr -- scores matches.csv --browser-dry-run
npm run utr -- scores matches.csv --live
npm run utr -- sync matches.csv --dry-run
```

- **Dry run:** no browser; prints every proposed action and dependency.
- **Browser dry run:** authenticates, verifies the configured event, searches players, fills safe controls, captures `*-before-submit.png`, and stops before the final button.
- Add `--keep-open` to any browser command to keep the window open after success or failure for inspection; press Ctrl+C once to close it safely.
- **Live:** requires the literal `--live` flag and a verified `UTR_EVENT_NAME`. Create/sync processes only `R16-1` on its first safety run. After confirming it in UTR, process the remaining ready rows with:

  ```bash
  npm run utr -- create matches.csv --live --all
  ```

`scores --live` processes only score-bearing rows and verifies the rendered result. Each successful live operation is immediately written back using an atomic CSV replacement. User fields and unknown extra CSV columns are retained.

## Recommended workflow (one event, end to end)

1. `validate` then `plan` (no browser) to check the bracket and see every proposed action.
2. `create --browser-dry-run` to confirm login, event name, player matching and the form, with nothing submitted.
3. `create --live` creates **one** match (the first pending one, or `--only <match_id>`). Confirm it in UTR.
4. `create --live --all` creates the rest of the round. Re-running is safe: existing matches are detected by stored ID, then by the exact players on a single match card.
5. After play, put `winner` and `score` in `matches.csv` and run `sync --live --all`. This enters scores, then unlocks and creates the next round in one pass. `scores --live` only enters scores.
6. Any row the tool cannot verify (ambiguous/missing player, round not offered, duplicate match in UTR, score not shown after saving) is marked `NEEDS_REVIEW` and the command exits with code 2.

Writes are confirmed by UTR's own API response (HTTP status) and then by re-reading the match card, not by page-load heuristics. Use `--only <match_id>` to re-run a single match.

### Learning UTR's real controls

`npm run utr -- capture` opens the event; create one match and enter one score by hand, then press Ctrl+C. `logs/utr-api-capture.json` records only HTTP method, endpoint template, status and payload *shape* (no headers, cookies, tokens or values). Use it to confirm selectors in `src/utr/selectors.ts`, and as the basis for a direct API client if UTR's terms allow it; the UI path is the supported default. If your event's score dialog lists inputs player by player instead of per set, set `UTR_SCORE_INPUT_ORDER=rows` (labelled "Set N / Player N" inputs are mapped automatically).

## CSV and bracket

The full schema is:

```text
match_id,round,player_a,player_b,depends_on_a,depends_on_b,match_date,match_time,winner,score,status,utr_match_id,utr_match_url,utr_sync_status,utr_synced_at
```

Set a feeder by match ID (for example `depends_on_a=R16-1`). Winners propagate on every command. A dependent row remains `WAITING_FOR_WINNERS` until both winners exist, then becomes `READY_TO_CREATE`. Supported score syntax is `6-4,6-3`, `6-4,3-6,6-2`, or `6-4,3-6,10-7`; the UI field count is inspected before population rather than assuming the event format.

Idempotency checks stored UTR URL/ID first, then the rendered event page for the exact normalized players and round. This provides reconciliation if UTR creation succeeds but the process exits before the CSV write. Ambiguous/missing players and unsafe scores become `NEEDS_REVIEW`; the script does not guess.

## Browser behavior and selector discovery

Semantic candidates are centralized in `src/utr/selectors.ts`. The implementation prefers accessible roles/labels/text and only uses stable data attributes or descriptive inputs as fallbacks. Each browser run writes `logs/utr-selector-report.json`, listing selectors actually present on the configured page. UTR can change its private UI; review this report before enabling live mode after a UI change.

Screenshots are written to `screenshots/`. Human-readable and structured daily logs are written to `logs/utr-sync-YYYY-MM-DD.log` and `.json`. Browser profiles, screenshots, and execution logs are ignored because they may contain private event/player information; placeholder directories are retained.

## Development

```bash
npm test            # unit tests, no browser
npm run test:e2e    # full 15-match event against a local UTR mock, headless Chromium
npm run mock:utr    # run the mock on :4510 to watch the flow manually
npm run build
```

`tests/mock-utr/` is a stand-in for a director's event page (match cards, typeahead player dialog, per-match score dialog, duplicate-rejecting API). The e2e suite runs the real CLI against it: dry runs, the one-match live gate, `--all`, idempotent re-runs, scoring (including a match tiebreak), unlocking QF/SF/Final, ambiguous-name review, and the event-name guard. Set `UTR_BROWSER_EXECUTABLE` to use a specific Chromium. The mock proves the automation logic; it cannot prove UTR's real selectors, which is what the browser dry run and `capture` are for.

Unit/integration coverage uses Node's built-in test runner and includes CSV parsing, duplicate IDs/players, dependencies, multi-round propagation, score formats and winner consistency, missing players, normalized-name idempotency, and later-round unlocking.

## Limitations

- UTR does not publish a stable event-management DOM contract. Browser dry-run is therefore the mandatory selector-discovery gate for the configured account/event.
- The match-tiebreak is accepted locally but live population proceeds only if UTR presents enough score inputs for that event format.
- An authenticated profile and event URL were not included in this repository; no real player resolution or event mutation can be tested without the authorized account owner completing login and configuration.
- Automated checks never bypass CAPTCHA, MFA, access controls, or security challenges.

### Login troubleshooting

If the CLI reports that authentication is required, confirm `.env` contains `UTR_HEADLESS=false` and rerun the browser dry run. The CLI now clicks a visible Log in / Sign in control when one is available and monitors all browser tabs, including OAuth popup flows. Complete login in the browser window and leave it open; authentication is detected from UTR's accessible account controls or authenticated browser state, without reading or logging credential/token values. On a truly display-less Linux host, run the first login from a desktop machine or a legitimate remote desktop session using the same protected profile directory—do not copy credentials into configuration.

For the configured draw, start with `npm run utr -- create matches.csv --browser-dry-run --keep-open`. This opens the exact URL (including its draw/tab query parameters), discovers the controls that the authenticated account can access, does not press a final create/save/publish button, and leaves the browser visible even if selector discovery fails. Press Ctrl+C in the terminal to close it.
