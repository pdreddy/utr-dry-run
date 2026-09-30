/** Centralized, ordered semantic selector candidates. Update from discovery reports as UTR evolves. */
export const SELECTORS = {
  authenticated: [
    '[data-testid="user-menu"]', '[aria-label*="profile" i]',
    'a[href*="logout" i]', 'button:has-text("Log out")'
  ],
  eventDesk: [
    'a:has-text("Event Desk")', 'button:has-text("Event Desk")',
    'a:has-text("Manage")', '[data-testid="event-desk"]'
  ],
  createMatch: [
    'button:has-text("Add Match")', 'button:has-text("Create Match")',
    'button:has-text("Schedule Match")', '[data-testid="create-match"]'
  ],
  playerA: [
    'input[aria-label*="player 1" i]', 'input[aria-label*="player a" i]',
    'input[name*="player1" i]', 'input[placeholder*="player" i]'
  ],
  playerB: [
    'input[aria-label*="player 2" i]', 'input[aria-label*="player b" i]',
    'input[name*="player2" i]', 'input[placeholder*="player" i]'
  ],
  round: ['[aria-label*="round" i]', 'select[name*="round" i]', 'input[name*="round" i]'],
  finalCreate: [
    'button:has-text("Create Match")', 'button:has-text("Publish")',
    'button:has-text("Submit")', 'button:has-text("Save")'
  ],
  scoreEntry: [
    'button:has-text("Enter Score")', 'button:has-text("Add Score")',
    'button:has-text("Edit Score")', '[data-testid="enter-score"]'
  ],
  scoreInputs: ['input[inputmode="numeric"]', 'input[type="number"]', 'input[aria-label*="set" i]'],
  finalScore: ['button:has-text("Submit Score")', 'button:has-text("Post Score")', 'button:has-text("Save Score")']
} as const;
