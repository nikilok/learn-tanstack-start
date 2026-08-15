// What kind of session this is, and how the header says so.
//
// Separated from the header because it used to be a ternary on `dryRun`, which has exactly two
// answers — so a mock session, whose data is synthetic and whose writes go to a sandbox, rendered
// as (LIVE). An operator reading that header is reading it to decide whether to trust the numbers.

export type RunMode = 'live' | 'dry-run' | 'mock';

export type ModeBadge = {
  text: string;
  color: string;
  /** Reversed video. The two ordinary modes differ only by colour; a mock session has to survive a glance. */
  inverse: boolean;
};

/** Which of the three a session is. Mock outranks dry-run: a sandboxed session cannot reach the real WAF at all, so "none of this is real" is the stronger thing to say. */
export function runModeOf(opts: { dryRun: boolean; mock: boolean }): RunMode {
  if (opts.mock) return 'mock';
  return opts.dryRun ? 'dry-run' : 'live';
}

const BADGES: Record<RunMode, ModeBadge> = {
  live: { text: '(LIVE)', color: 'green', inverse: false },
  'dry-run': { text: '(DRY-RUN)', color: 'yellow', inverse: false },
  mock: { text: '(MOCK)', color: 'magenta', inverse: true },
};

/** How the header renders a mode. */
export function badgeFor(mode: RunMode): ModeBadge {
  return BADGES[mode];
}

/** The one-line caption under the header, or undefined when there is nothing to say. Only a mock session has something: everything on screen is recorded or synthetic, and nothing it writes leaves the sandbox. */
export function modeNote(mode: RunMode): string | undefined {
  return mode === 'mock'
    ? 'synthetic data · sandboxed state · no credentials'
    : undefined;
}
