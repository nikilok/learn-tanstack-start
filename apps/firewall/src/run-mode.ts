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

/**
 * The one-line caption under the header, or undefined when there is nothing to say.
 *
 * "recorded", not "synthetic". The traffic on screen is a real recording — real client IPs, real
 * fingerprints — and calling it synthetic invites someone to treat the screen as safe to share.
 * What IS synthetic is the seeded rule config, which is not what this line is about.
 */
export function modeNote(mode: RunMode): string | undefined {
  return mode === 'mock'
    ? 'recorded traffic · sandboxed state · no credentials'
    : undefined;
}

/**
 * What to print after a headless apply.
 *
 * Three sessions, three different truths, and recording is not a RunMode — it is a live session
 * that also writes a cassette. It got the live wording, which claims enforcement was preserved,
 * directly under eighteen lines of "recording is read-only" refusals.
 */
export function appliedNote(session: {
  mock: boolean;
  recording: boolean;
}): string {
  if (session.mock)
    return 'Applied to the in-memory WAF. Nothing reached production; this session has no credentials.';
  if (session.recording)
    return 'Nothing was applied: a recording is read-only. Re-run without --record to apply.';
  return 'Applied. Live enforcement preserved; new rules inserted with code defaults. Tune actions in the TUI.';
}
