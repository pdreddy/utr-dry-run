/**
 * Centralized, ordered semantic selector candidates. Update from discovery
 * (`logs/utr-selector-report.json`) and API capture reports as UTR evolves.
 *
 * Every match-level action is scoped to a single match card and every form
 * action to the open dialog, so a page-wide fallback can never act on the
 * wrong match.
 */
export const SELECTORS = {
  authenticated: [
    '[data-testid="user-menu"]', '[aria-label*="profile" i]',
    '[data-testid*="avatar" i]', 'a[href*="logout" i]',
    'button:has-text("Log out")', 'button:has-text("Sign out")',
    'a[href*="/profile/"]', 'a[href*="/home"]'
  ],
  login: [
    'input[type="password"]', 'input[type="email"]',
    'button:has-text("Log in")', 'button:has-text("Sign in")',
    'a:has-text("Log in")', 'a:has-text("Sign in")',
    'button:has-text("Login")', 'a:has-text("Login")',
    'button:has-text("Join / Sign In")', 'a:has-text("Join / Sign In")'
  ],
  // Never match a bare "Manage": it resolves to the footer's "Manage Cookies" link.
  eventDesk: [
    'a:text-is("Event Desk")', 'button:text-is("Event Desk")', '[data-testid="event-desk"]'
  ],
  createMatch: [
    'button:has-text("Add Match")', 'button:has-text("Create Match")',
    'button:has-text("Schedule Match")', '[data-testid="create-match"]'
  ],
  dialog: ['[role="dialog"]', '[aria-modal="true"]', '.modal.show', '.modal'],
  /** A rendered match in the draw/match list; must contain both player names. */
  matchCard: [
    '[data-testid="match-card"]', '[data-testid*="match" i][data-match-id]',
    '[role="group"][aria-label*="match" i]', '[class*="matchCard" i]', '[class*="match-card" i]'
  ],
  /** Within a dialog. Player B never falls back to a generic selector shared with player A. */
  playerA: [
    'input[aria-label*="player 1" i]', 'input[aria-label*="player a" i]',
    'input[name*="player1" i]', 'input[name*="playerOne" i]'
  ],
  playerB: [
    'input[aria-label*="player 2" i]', 'input[aria-label*="player b" i]',
    'input[name*="player2" i]', 'input[name*="playerTwo" i]'
  ],
  playerInputs: ['input[placeholder*="player" i]', 'input[aria-label*="player" i]'],
  round: ['select[aria-label*="round" i]', 'select[name*="round" i]', 'input[aria-label*="round" i]', 'input[name*="round" i]'],
  finalCreate: [
    'button:has-text("Create Match")', 'button:has-text("Publish")',
    'button:has-text("Submit")', 'button:has-text("Save")'
  ],
  scoreEntry: [
    'button:has-text("Enter Score")', 'button:has-text("Add Score")',
    'button:has-text("Edit Score")', '[data-testid="enter-score"]'
  ],
  scoreInputs: ['input[inputmode="numeric"]', 'input[type="number"]', 'input[aria-label*="set" i]'],
  finalScore: [
    'button:has-text("Submit Score")', 'button:has-text("Post Score")',
    'button:has-text("Save Score")', 'button:has-text("Save")'
  ]
} as const;

/** Draw editor (Event Desk): empty-slot label and the controls that must never be clicked. */
export const EDITOR = {
  emptySlot: 'Select a player',
  matchHeader: /^Match #(\d+)/,
  forbiddenClick: /publish|unpublish|discard|delete|remove|reset|clear/i
} as const;
