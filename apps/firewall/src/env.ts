// Every environment read the tool makes, in one place.
//
// Two rules hold this module together, and both were learned the hard way:
//
// 1. **It imports nothing.** `setup.tsx` used to re-derive `dryRun` from argv itself rather than
//    import it, because the only definition lived in `rules.ts` — and importing that evaluates the
//    whole rule set, which throws when a ceiling is missing, before `main().catch()` exists to
//    turn it into a readable message. A shared definition is only shareable if reaching it is free.
//
// 2. **Nothing here is a top-level const, and nothing throws.** Reading at module scope is what
//    made `rules.ts` and `client.ts` poison themselves for the rest of the process when the
//    environment was not ready. Functions are re-readable, cost nothing, and let a test pass
//    explicit values without touching the environment at all. `tuning.ts` already says this.
//
// Semantic accessors do NOT belong here. `tuning.ts` stays the only reader of the calibration
// thresholds, deliberately, so the numbers have exactly one home.

/** Trimmed value of `name`, or undefined when unset or blank. */
export function envText(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** A firewall ceiling (FW_*_LIMIT), or undefined when absent or not a positive integer. Shared so the rules and the report agree on what is valid. */
export function envCeiling(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Whether this run only previews.
 *
 * Read from argv as well as the environment, because the flag is how an operator asks for it and
 * the variable is how CI and the tests do. It gates every write: no WAF call, and no `.env.local`.
 */
export function isDryRun(): boolean {
  return process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
}

/** Whether the operator asked to apply for real. Mutually exclusive with a dry run; the entrypoint enforces that. */
export function isApply(): boolean {
  return process.argv.includes('--apply');
}

/** Whether this is a mock session: recorded data, a sandboxed state directory, and fabricated credentials. */
export function isMock(): boolean {
  return process.argv.includes('--mock');
}

/** Whether this run captures its live responses into the cassette a later mock session replays. */
export function isRecording(): boolean {
  return process.argv.includes('--record');
}

/** Whether output should carry colour. A pipe or NO_COLOR means plain text. */
export function useColour(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/** Whether both ends of the terminal are interactive, which is what decides TUI vs headless. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
