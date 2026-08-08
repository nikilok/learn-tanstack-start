// Watch mode: the TUI's own loop screens on a timer, and hands anything suspicious to the
// `claude` CLI to investigate. Detection is one query and costs nothing; adjudication starts a
// billable agent. Everything here is the gate between the two.
//
// The gate matters more than it looks. The screen has never once fired on a live positive, so its
// false-positive rate is a number nobody has. An ungated version would start an investigation per
// tick the first time Vercel's classification shifts under us.

import { type Advice } from './ban-advice';
import { watchHours } from './tuning';

/** Investigations per hour, whatever the screen says. Caps our spend, not our detection. */
export const SPAWN_CEILING = 3;
export const CEILING_WINDOW_MS = 60 * 60_000;

/**
 * `caffeinate` arguments that keep the machine up while the loop is armed.
 *
 * `-i` is the one that matters: idle sleep is what suspends a process that only wakes every
 * fifteen minutes. `-s` covers system sleep and is a no-op off AC, which a Mac mini never is.
 * `-m` keeps the disk from idling under it.
 *
 * Deliberately NOT `-d`: nothing here needs the display awake, and burning a monitor overnight to
 * run a background screen is a cost with no benefit.
 *
 * `-w` is the part that matters for cleanup. caffeinate exits on its own when the given pid does,
 * so a crash or a kill -9 that never reaches the effect teardown still cannot strand an assertion
 * that keeps the machine awake indefinitely.
 */
export function caffeinateArgs(pid: number): string[] {
  return ['-i', '-s', '-m', '-w', String(pid)];
}

/** Only macOS has caffeinate; elsewhere the loop runs without it rather than failing to arm. */
export function canKeepAwake(platform: string): boolean {
  return platform === 'darwin';
}

export type Suspicious = {
  digest: string;
  allowed: number;
  total: number;
  advice: Advice;
};

/**
 * Whether a finding warrants starting an investigation. `ban` is the bar: anything softer is for a
 * human reading the screen, not for spending an agent on.
 *
 * Two guards, and both exist because the loop repeats. A digest already investigated this session
 * is skipped whatever the verdict — the same scraper is still there on the next tick, and without
 * this it would be re-investigated every fifteen minutes forever. The hourly ceiling catches the
 * case the first guard cannot: many distinct digests arriving at once, which is what a
 * classification change looks like from in here.
 */
export function shouldInvestigate(
  f: Suspicious,
  seen: ReadonlySet<string>,
  spawnsAt: readonly number[],
  now: number,
  ceiling = SPAWN_CEILING,
  windowMs = CEILING_WINDOW_MS,
): boolean {
  if (f.advice.verdict !== 'ban') return false;
  if (seen.has(f.digest.toLowerCase())) return false;
  return spawnsAt.filter((t) => now - t < windowMs).length < ceiling;
}

/** Drops spawn timestamps that have aged out, so the list cannot grow for the life of the session. */
export function recentSpawns(
  spawnsAt: readonly number[],
  now: number,
  windowMs = CEILING_WINDOW_MS,
): number[] {
  return spawnsAt.filter((t) => now - t < windowMs);
}

/** A JA4 digest and nothing else. What reaches the prompt has to be shaped, not merely quoted. */
const JA4 = /^t[0-9a-z]{9}_[0-9a-f]{12}_[0-9a-f]{12}$/i;

/**
 * The prompt handed to the CLI.
 *
 * Only the digest, the counts and the advisory's own reasons go in. Everything a client controls —
 * user agents, paths, referrers — is left out: it would be attacker-authored text arriving in an
 * instruction, and no amount of fencing makes that safe. The digest is shape-checked rather than
 * trusted, since it is the one field that crosses over.
 */
export function investigationPrompt(f: Suspicious, hours: number): string {
  const digest = JA4.test(f.digest) ? f.digest : '(malformed digest)';
  const reasons = f.advice.reasons.map((r) => `- ${r}`).join('\n');
  return [
    `The firewall watch flagged JA4 ${digest} over the last ${hours}h.`,
    `Vercel classified it browser_impersonation and allowed it: ${f.allowed} of ${f.total} requests.`,
    '',
    'The local advisory returned "ban" on this evidence:',
    reasons || '- (none recorded)',
    '',
    'Load the firewall-operator skill and work its investigation protocol against live data.',
    '',
    // Described rather than shown. Listing the options as literal `VERDICT: x` lines put three
    // parseable verdicts inside the prompt itself, so any reply quoting the instructions back —
    // a refusal, an error, a restatement — parsed as the first one, `ban`. The reader tolerates
    // a preamble by design, which is what made an echoed menu indistinguishable from an answer.
    'Begin your reply with one line: the word VERDICT, a colon, then exactly one of',
    'ban / leave / unclear. Nothing before that line, and do not restate these options.',
    '',
    'Then the evidence behind it, and — if it is a ban — the exact staging command and how to',
    'roll it back. Answer "unclear" rather than guessing: it reaches a human either way, and a',
    'confident wrong answer is the one thing this cannot recover from.',
    '',
    'Do not apply anything. Do not run firewall:setup, do not write .env.local, and do not',
    'change the WAF. A human runs the command.',
  ].join('\n');
}

/**
 * Pinned, not inherited. Without these the spawn picks up whatever model the operator's own
 * session happened to be on when they armed the watch, so the same fingerprint could be judged
 * by a different model at 3am than at noon — with nothing in the log saying which.
 *
 * `max` because the run is unattended and latency is therefore free, while the error is
 * asymmetric: a wrong `leave` costs another look, a wrong `ban` black-holes everyone sharing that
 * TLS stack.
 */
export const INVESTIGATION_MODEL = 'opus';
export const INVESTIGATION_EFFORT = 'max';

/**
 * Hard ceiling on one investigation. Generous, because `max` effort over a dozen observability
 * queries is genuinely slow — but finite, because the alternative is a hung child that every
 * later screen queues behind.
 */
export const INVESTIGATION_TIMEOUT_MS = 10 * 60_000;

/** Argv for the investigation. Read-only work, JSON out so the pane can render the verdict. */
export function investigationArgs(f: Suspicious, hours: number): string[] {
  return [
    '-p',
    investigationPrompt(f, hours),
    '--output-format',
    'json',
    '--model',
    INVESTIGATION_MODEL,
    '--effort',
    INVESTIGATION_EFFORT,
    // Not a sandbox — a spawned agent has been observed reaching a shell through a tool outside
    // this list, and Bash cannot be disallowed because the investigation needs it for read-only
    // queries. It narrows the default surface and states the intent; the instruction above is
    // what holds, and `investigationChangedConfig` is what notices if it did not.
    '--disallowed-tools',
    'Write',
    'Edit',
  ];
}

/** What the investigation concluded, read from its own structured first line. */
export type Verdict = 'ban' | 'leave' | 'unclear';

/**
 * The verdict line, or `unclear` when there is not one.
 *
 * Unparseable is deliberately NOT 'leave'. An investigation that ran and cannot be read is a
 * result nobody has seen — the one outcome that must reach a human, not be filed as fine.
 */
export function verdictFrom(text: string): Verdict {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^VERDICT:/i.test(l));
  const word = line
    ?.replace(/^VERDICT:\s*/i, '')
    .toLowerCase()
    .trim();
  return word === 'ban' || word === 'leave' ? word : 'unclear';
}

export type Investigation =
  | { ok: true; verdict: string; provenance: string }
  | { ok: false; error: string };

/**
 * Which models actually ran and what it cost, read from the CLI's own accounting rather than
 * from what we asked for. A verdict that recommends a ban should carry what produced it: the
 * pinned model is what we requested, this is what answered.
 */
export function provenanceOf(parsed: unknown): string {
  // `?? {}` because `JSON.parse('null')` succeeds and returns null, and reading a property off
  // that throws — a crash in the reporting path would lose a verdict that had already been paid
  // for.
  const r = (parsed ?? {}) as {
    modelUsage?: Record<string, { costUSD?: unknown }>;
    total_cost_usd?: unknown;
  };
  const models = Object.keys(r.modelUsage ?? {});
  const cost =
    typeof r.total_cost_usd === 'number'
      ? ` · $${r.total_cost_usd.toFixed(4)}`
      : '';
  return `${models.length ? models.join(', ') : 'model unreported'}${cost}`;
}

/**
 * Run the investigation and return what it concluded.
 *
 * `cwd` is the repo root so `.claude/skills/firewall-operator` is discovered and the firewall
 * commands resolve. Argv is passed as an array, never a shell string, so nothing in the prompt is
 * interpreted. A spawn that cannot start is a failure like any other — never a silent no-op,
 * which would leave the digest marked investigated with nothing to show for it.
 */
export async function runInvestigation(
  f: Suspicious,
  cwd: string,
  onStart?: (child: {
    kill: (signal?: number | NodeJS.Signals) => void;
  }) => void,
): Promise<Investigation> {
  try {
    const proc = Bun.spawn(['claude', ...investigationArgs(f, watchHours())], {
      cwd,
      stdout: 'pipe',
      // NOT piped. A pipe nobody reads fills its buffer and blocks the child forever, which for
      // this process means the watch never screens again.
      stderr: 'ignore',
      // An investigation that hangs must not outlive the loop that started it. Without this the
      // next screen waits behind it indefinitely and the watch is silently dead.
      timeout: INVESTIGATION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    // Hand the child up so disarm and unmount can stop it; the timeout only bounds the worst case.
    onStart?.(proc);
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return parseInvestigation(stdout, exitCode);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * What the CLI returned. `is_error` and a non-zero exit are different failures — a run can fail
 * cleanly and still exit 0 — so both are checked, and neither is allowed to read as a verdict.
 */
export function parseInvestigation(
  stdout: string,
  exitCode: number,
): Investigation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error:
        exitCode === 0
          ? 'claude returned output that was not JSON'
          : `claude exited ${exitCode} with no JSON`,
    };
  }
  // Same guard as provenanceOf: `null` is valid JSON, and reading `is_error` off it throws.
  const r = (parsed ?? {}) as { result?: unknown; is_error?: unknown };
  if (r.is_error === true || exitCode !== 0)
    return {
      ok: false,
      error:
        typeof r.result === 'string' && r.result
          ? r.result
          : `claude exited ${exitCode}`,
    };
  if (typeof r.result !== 'string' || !r.result)
    return { ok: false, error: 'claude returned no result text' };
  return {
    ok: true,
    verdict: r.result,
    provenance: provenanceOf(parsed),
  };
}

/** Investigations one unattended run may start, so a classification change cannot become a bill. */
export const INVESTIGATIONS_PER_RUN = 2;

/**
 * Which findings this run should investigate.
 *
 * Three gates, in order: the advisory says ban, we have not already bought this answer, and the
 * run has budget left. `seen` carries history, so it is checked by membership — counting it would
 * conflate a week of past runs with what this one has started.
 */
export function investigable<
  T extends { digest: string; advice: { verdict: string } },
>(
  findings: readonly T[],
  seen: ReadonlyMap<string, number>,
  budget = INVESTIGATIONS_PER_RUN,
): T[] {
  return findings
    .filter(
      (f) => f.advice.verdict === 'ban' && !seen.has(f.digest.toLowerCase()),
    )
    .slice(0, Math.max(0, budget));
}

/**
 * Whether the investigation left the firewall config as it found it.
 *
 * The disallow list above cannot stop a ban: adding one is an append to `.env.local` followed by
 * an apply, and `Bash` has to stay available for the read-only queries the protocol requires. The
 * comment beside that list used to claim a post-run check noticed — it did not exist, and the
 * only config read in the loop ran BEFORE the spawn. A safeguard asserted in a comment and absent
 * in the code is worse than none, because it stops the next reader from adding it.
 *
 * Cheap and blunt on purpose: a byte length and a modification time, taken either side. It cannot
 * say what changed, only that something did — which is the whole question for an unattended run.
 */
export type ConfigFingerprint = { size: number; mtimeMs: number } | null;

export async function fingerprintConfig(
  path: string,
): Promise<ConfigFingerprint> {
  try {
    const { stat } = await import('node:fs/promises');
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    // Unreadable BEFORE and unreadable AFTER agree, and that is the honest answer. A file that
    // could not be read either side is not evidence of a change.
    return null;
  }
}

/** True when the two fingerprints disagree — including one side being unreadable. */
export function investigationChangedConfig(
  before: ConfigFingerprint,
  after: ConfigFingerprint,
): boolean {
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}
