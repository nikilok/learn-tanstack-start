// Watch mode: the TUI's own loop screens on a timer, and hands anything suspicious to the
// `claude` CLI to investigate. Detection is one query and costs nothing; adjudication starts a
// billable agent. Everything here is the gate between the two.
//
// The gate matters more than it looks. The screen has never once fired on a live positive, so its
// false-positive rate is a number nobody has. An ungated version would start an investigation per
// tick the first time Vercel's classification shifts under us.

import { type Advice, worthInvestigating } from './ban-advice';
import { isMock } from './env';

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
 * Whether a finding warrants starting an investigation. TWO INDEPENDENT AXES is the bar — the same
 * one a ban needs — not the verdict.
 *
 * It used to be `verdict === 'ban'`, which meant an identity was only investigated once a safe
 * lever already existed. That excluded exactly the case worth automating: scraper-shaped on two
 * axes with every handle SHARED returns `watch`, and on 2026-08-12 it cost a human most of a night
 * to adjudicate by hand. The noisy half of `watch` — too little traffic, a failed query, evidence
 * spread across fingerprints — scores under two axes and is still skipped.
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
  // Two independent axes, NOT `verdict === 'ban'`. The bar used to be the verdict, which meant an
  // identity was only investigated once a safe lever already existed — so the shared-fingerprint
  // case, where the evidence is strongest and the lever hardest, was the one thing never looked
  // at. Cost is unchanged: the ceiling below and INVESTIGATIONS_PER_RUN bound spawns regardless of
  // how many findings qualify.
  if (!worthInvestigating(f.advice)) return false;
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
    // The real verdict, not a hardcoded "ban". Telling the agent the advisory said ban when it
    // said watch is a false premise it will then try to justify — and the shared-fingerprint case
    // is exactly where the advisory's own answer is the most informative part of the brief.
    `The local advisory returned "${f.advice.verdict}" on this evidence (${f.advice.axes.length} independent axes):`,
    reasons || '- (none recorded)',
    ...(f.advice.leverNotes.length
      ? [
          '',
          'Why it could not name a safe lever:',
          f.advice.leverNotes.map((n) => `- ${n}`).join('\n'),
        ]
      : []),
    '',
    'Load the firewall-operator skill and work its investigation protocol against live data.',
    '',
    // Described rather than shown. Listing the options as literal `VERDICT: x` lines put three
    // parseable verdicts inside the prompt itself, so any reply quoting the instructions back —
    // a refusal, an error, a restatement — parsed as the first one, `ban`. The reader tolerates
    // a preamble by design, which is what made an echoed menu indistinguishable from an answer.
    'Begin your reply with one line: the word VERDICT, a colon, then exactly one of',
    'ban / challenge / leave / unclear. Nothing before that line, and do not restate these',
    'options.',
    '',
    'Choose challenge over ban when the identity is automated but its fingerprint is SHARED —',
    'real browsers render from it in the >= 6 day reach — AND its traffic in this window renders',
    'nothing. That client cannot answer an interstitial while a browser can, so a challenge is',
    'terminal for it at near-zero cost to the people sharing the TLS build. It targets',
    'FW_CHALLENGE_JA4 rather than FW_BLOCKED_JA4.',
    '',
    'Then the evidence behind it, and — if it is a ban or a challenge — the exact staging command',
    'and how to roll it back. Answer "unclear" rather than guessing: it reaches a human either',
    'way, and a confident wrong answer is the one thing this cannot recover from.',
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

/** 128 + SIGKILL(9). The only SIGKILL here is the timeout below, so this exit code names it. */
const TIMEOUT_EXIT = 137;

/**
 * Hard ceiling on one investigation. Finite, because the alternative is a hung child that every
 * later screen queues behind — but it must clear the real distribution, and at 10 minutes it did
 * not.
 *
 * Measured over five real runs: successes took 6m45, 8m41 and 9m15, and the two that were killed
 * both died at exactly 10m00 on identities that mattered. The ceiling sat 45 seconds above the
 * worst success, so the outcome was close to a coin flip.
 *
 * A kill here does NOT save the spend — the tokens are already bought by minute ten, and SIGKILL
 * simply discards what they produced ($1.66-$2.38 per run, and both losses were total). Cutting it
 * short maximises waste rather than bounding it; the count is bounded by SPAWN_CEILING and
 * INVESTIGATIONS_PER_RUN, which is where that job belongs. So: roughly double the worst observed
 * success, and re-measure from the log before changing it again.
 */
export const INVESTIGATION_TIMEOUT_MS = 20 * 60_000;

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
export type Verdict = 'ban' | 'challenge' | 'leave' | 'unclear';

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
  // `challenge` is a real conclusion, not a hedge: a shared fingerprint carrying a non-JS client
  // is the common case, and forcing that answer into `unclear` loses the one recommendation that
  // is both safe and actionable. Anything unrecognised is still `unclear`.
  return word === 'ban' || word === 'challenge' || word === 'leave'
    ? word
    : 'unclear';
}

export type Investigation =
  | { ok: true; verdict: string; provenance: string }
  /** `ceiling` — killed by our own timeout rather than failing on its own. Retrying buys the same wall again, so the caller keeps the investigated mark instead of releasing it. */
  | { ok: false; error: string; ceiling?: boolean };

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
  /** Hours actually screened. Required: a default silently disagrees with a positional override. */
  hours: number,
  onStart?: (child: {
    kill: (signal?: number | NodeJS.Signals) => void;
  }) => void,
): Promise<Investigation> {
  // A mock session must not spawn a real agent: it costs real money and would adjudicate synthetic
  // traffic. Labelled rather than silent, so nobody reads the pane as a real conclusion.
  if (isMock())
    return {
      ok: true,
      verdict: `MOCK: no investigation was run for ${f.digest}. This text is a placeholder so the verdict pane renders.`,
      provenance: 'mock session',
    };
  try {
    const proc = Bun.spawn(['claude', ...investigationArgs(f, hours)], {
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
    const startedAt = Date.now();
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    // Carried on SUCCESS too, deliberately. Two runs were killed at the ceiling before anyone
    // noticed the successful ones were finishing within a minute of it — a duration recorded only
    // on failure tells you after it starts failing, which is the wrong time to learn it.
    return parseInvestigation(stdout, exitCode, Date.now() - startedAt);
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
/** `8m41s`, for a log line read at a glance beside a ceiling measured in minutes. */
export function elapsedLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

export function parseInvestigation(
  stdout: string,
  exitCode: number,
  /** Wall time the child took. Optional so existing callers and tests keep their shape. */
  elapsedMs?: number,
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
          : // 137 is SIGKILL, and the only thing here that sends one is our own timeout. Naming it
            // matters: "exited 137" reads as a crash in the child and sent the last diagnosis
            // hunting through Claude's logs, when the caller had killed it.
            exitCode === TIMEOUT_EXIT
            ? `claude was killed by this tool's own ${INVESTIGATION_TIMEOUT_MS / 60_000}-minute ceiling before it answered — the spend happened, the verdict was lost`
            : `claude exited ${exitCode} with no JSON`,
      ceiling: exitCode === TIMEOUT_EXIT,
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
    // Elapsed rides the provenance line, which the log already prints beside the models and the
    // cost. It is the only place the margin against the ceiling is visible before it runs out.
    provenance:
      elapsedMs === undefined
        ? provenanceOf(parsed)
        : `${provenanceOf(parsed)} · ${elapsedLabel(elapsedMs)}`,
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
  T extends { digest: string; advice: Pick<Advice, 'axes' | 'verdict'> },
>(
  findings: readonly T[],
  seen: ReadonlyMap<string, number>,
  budget = INVESTIGATIONS_PER_RUN,
): T[] {
  return findings
    .filter(
      (f) => worthInvestigating(f.advice) && !seen.has(f.digest.toLowerCase()),
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
