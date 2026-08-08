// Entrypoint for `bun run firewall:watch` — what is getting through that should not be.
// READ-ONLY. It never stages a deny and never applies; it prints a case and a human decides.
//
// It does NOT try to find scrapers from first principles. Vercel's managed bot protection
// already handles most of what it classifies, so the screen asks for that classification and
// looks only at what was classified as impersonating a browser and then reached the app anyway.
// A challenge is a test, not a wall: whatever passes it arrives clean, and something capable of
// passing is more interesting than something that never faced one.
//
// Adjudicating those is the part Vercel cannot do. Deciding a fingerprint is safe to DENY rather
// than merely challenge needs to know what a real session on this site looks like.

import { type BanCandidate, autoBanRefusal } from './auto-ban';
import {
  type Advice,
  type Reach,
  adviseBan,
  browserEvidence,
} from './ban-advice';
import { resolveVercelCredentials } from './credentials';
import { ASN_DENY, JA4_DENY, envMatching } from './deny-list';
import { fetchIpProfile } from './ip-profile';
import { mixOf, renderingRequests } from './ip-signals';
import { type Line, blank, line, seg, toAnsi } from './line-model';
import { type Row, countOf, makeCtx, metrics } from './observability';
import { trustedRules } from './rule-integrity';
import { type Window, rollingWindow } from './time-window';
import { allowedBots, screenFloor, watchHours } from './tuning';
import { errMsg } from './util';
import { logWatch } from './watch-log';
import { investigable, runInvestigation, verdictFrom } from './watch-mode';
import {
  actionableKey,
  concludedKey,
  concludedText,
  notify,
  notifyText,
  readInvestigated,
  writeInvestigated,
  rememberNotified,
  shouldNotify,
} from './watch-notify';

const MAX_HOURS = 24 * 6; // the free observability window
// A profile is expensive; a screen that suddenly matches everything means the category changed,
// not that the site is under attack from fifty actors at once.
const MAX_PROFILES = 6;

const USAGE = `Usage:
  bun run firewall:watch [hours] [--investigate] [--notify]
                                     max ${MAX_HOURS}h

Read-only. Exits 0 quiet, 1 found something, 2 could not run properly.`;

/** Above this share of rendering requests, a browser has run the app from the fingerprint. */
const MAX_RENDER_SHARE = 0.05;

export type Screened = {
  digest: string;
  allowed: number;
  /** Which screen surfaced it, and why. Carried so a candidate can say what made it one. */
  why: string[];
};

/**
 * Digests carrying a verified crawler WE WANT — the only ones the behavioural screen skips.
 *
 * `botVerified` is NOT a boolean: the value is `'pass'`, and `botVerified eq 'true'` is accepted
 * by the API while matching nothing — the same trap as `botCategory`. Worse, `ne 'true'` matches
 * everything including the verified. So it is selected here, never filtered.
 *
 * Verification is reverse DNS with forward confirmation, so it cannot be faked by renting a VM in
 * the right network: measured 2026-08-06, Google's and Microsoft's own ASNs each carried hundreds
 * of UNVERIFIED requests alongside their verified crawlers. But proving a crawler is who it says
 * is not the same as wanting it: SEO and AI harvesters pass identically to a search engine. Only
 * the names on FW_ALLOWED_BOTS are excluded from candidacy; the rest stay screenable.
 *
 * `allowed` undefined means the list was not read, and every verified crawler is skipped — the
 * behaviour before the list existed. A config that failed to load must not put Googlebot on the
 * candidate list.
 */
export function verifiedDigests(
  summary: Row[],
  allowed?: readonly string[],
): Set<string> {
  const want = allowed && new Set(allowed.map((n) => n.toLowerCase()));
  return new Set(
    summary
      .filter((r) => String(r.botVerified ?? '') === 'pass')
      .filter(
        (r) =>
          !want ||
          want.has(
            String(r.botName ?? '')
              .trim()
              .toLowerCase(),
          ),
      )
      .map((r) => JA4_DENY.normalize(String(r.clientJa4Digest ?? '')))
      .filter(Boolean),
  );
}

/**
 * Fingerprints doing volume without rendering anything, excluding confirmed crawlers.
 *
 * This is the screen that does not depend on Vercel having classified the traffic — the category
 * is empty for most real users, so anything that evades classification lands in a bucket the
 * category screen cannot see. Rendering share is the discriminator because it is bimodal on live
 * traffic rather than a threshold anyone had to tune: browser sessions render 43-78% of their
 * requests, everything else renders under 2%.
 *
 * A crawler is excluded because not rendering IS the job, not a tell. Applied to a live window,
 * that exclusion took eight candidates down to one.
 */
export function nonRendering(
  routeRows: Row[],
  verified: ReadonlySet<string>,
  maxShare = MAX_RENDER_SHARE,
): Screened[] {
  // Keyed on the normalised digest. The API echoes digests in either case, and two casings of one
  // fingerprint would otherwise be totalled separately — splitting its traffic, splitting its
  // rendering share, and turning one browser session into two apparent harvesters.
  const byDigest = new Map<string, [string, number][]>();
  for (const r of routeRows) {
    const raw = String(r.clientJa4Digest ?? '');
    if (!raw || raw === '(none)' || raw === '?') continue;
    const d = JA4_DENY.normalize(raw);
    const paths = byDigest.get(d) ?? [];
    paths.push([String(r.route ?? ''), countOf(r)]);
    byDigest.set(d, paths);
  }
  // Normalised here rather than trusted from the caller. `verifiedDigests` already does it, but
  // this exclusion is the only thing keeping legitimate crawlers out of the candidate list, and a
  // set built any other way would silently fail to match — surfacing Googlebot as a suspect.
  const crawlers = new Set([...verified].map((d) => JA4_DENY.normalize(d)));
  const out: Screened[] = [];
  for (const [digest, paths] of byDigest) {
    if (crawlers.has(digest)) continue;
    const total = paths.reduce((n, [, c]) => n + c, 0);
    if (total <= 0) continue;
    const share = renderingRequests(mixOf(paths)) / total;
    if (share > maxShare) continue;
    out.push({
      digest,
      allowed: total,
      why: [`${(share * 100).toFixed(1)}% rendering, not a verified crawler`],
    });
  }
  return out.sort((a, b) => b.allowed - a.allowed);
}

/**
 * One candidate list from several screens. Deduped by digest with the reasons merged, so a
 * fingerprint both screens found is profiled once and says so.
 */
export function mergeScreens(...lists: Screened[][]): Screened[] {
  const by = new Map<string, Screened>();
  for (const s of lists.flat()) {
    const key = s.digest.toLowerCase();
    const prior = by.get(key);
    if (!prior) by.set(key, { ...s, why: [...s.why] });
    else {
      // The screens count different things — impersonation requests versus all of them — so the
      // larger is the honest figure for "how much traffic is this".
      prior.allowed = Math.max(prior.allowed, s.allowed);
      for (const w of s.why) if (!prior.why.includes(w)) prior.why.push(w);
    }
  }
  return [...by.values()].sort((a, b) => b.allowed - a.allowed);
}

/** One adjudicated candidate: what the screen saw, and what the advisory made of it. */
export type Finding = Screened & {
  total: number;
  advice: Advice;
  /**
   * What autonomous applying WOULD have done, had it been wired: the refusal reason, or `null`
   * for a candidate it would have denied. Nothing acts on this — it exists so the gate's answers
   * accumulate in the log before anything is allowed to act on them, because the screen has never
   * produced a live `ban` and a rate nobody has measured is not a rate.
   */
  autoBanRefusal: string | null;
};

/**
 * Record what autonomous applying WOULD have decided. Applies nothing — `auto-ban.ts` is unwired,
 * deliberately, and this is how the evidence for wiring it gets collected.
 *
 * Only `ban` verdicts are recorded. For anything softer the gate's answer is "verdict is X, not
 * ban", which measures the advisory rather than the gate and would bury the real answers.
 */
export async function logShadow(
  dir: string,
  findings: readonly Finding[],
): Promise<void> {
  for (const f of findings)
    if (f.advice.verdict === 'ban')
      await logWatch(dir, new Date(), {
        kind: 'shadow',
        digest: f.digest,
        refusal: f.autoBanRefusal,
      });
}

/**
 * The blast-radius candidate for a finding, shaped so an unmeasured metric arrives as `NaN`.
 *
 * Reach that is absent or INCOMPLETE yields NaN rather than its numbers. A truncated path sample
 * reports zero rendering, and zero rendering is the single strongest reason `autoBanRefusal` has
 * to permit a deny — so absence must not arrive as the measurement that clears the gate. NaN is
 * refused by name; a zero would be believed.
 */
export function banCandidate(input: {
  digest: string;
  advice: { verdict: string; blockers: string[] };
  reach: Reach | undefined;
  total: number;
  windowTotal: number;
}): BanCandidate {
  const measured = input.reach?.complete ? input.reach : undefined;
  return {
    digest: input.digest,
    verdict: input.advice.verdict,
    blockers: input.advice.blockers,
    renderingRequests: measured ? browserEvidence(measured) : Number.NaN,
    ips: measured ? measured.ips : Number.NaN,
    total: input.total,
    windowTotal: input.windowTotal,
  };
}

/**
 * All traffic in the window — the denominator a candidate's share is measured against.
 *
 * Grouped by `wafAction` because it is the lowest-cardinality dimension available, so this one
 * cannot be silently truncated by the group cap the way a path or IP grouping can. A failed query
 * returns NaN, never 0: zero is a denominator that makes every candidate's share unmeasurable in
 * a direction that reads as small, and NaN is what the gate refuses on.
 */
export async function windowTotalOf(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
): Promise<number> {
  try {
    const { ctx } = makeCtx(creds, window);
    const rows = (await metrics(ctx, ['wafAction'], { limit: GROUP_CAP }))
      .summary;
    if (!rows?.length) return Number.NaN;
    return rows.reduce((a, r) => a + countOf(r), 0);
  } catch {
    return Number.NaN;
  }
}

export type WatchReport = {
  window: Window;
  /** Requests Vercel classified browser_impersonation that still reached the app. */
  screened: number;
  fingerprints: number;
  candidates: number;
  /** The screened response hit the group cap, so rows we wanted may have been dropped. */
  truncated: boolean;
  findings: Finding[];
  enforcement: string[];
  errors: string[];
};

/** 0 quiet, 1 ran and found something, 2 could not run properly. */
export const EXIT_QUIET = 0;
export const EXIT_FOUND = 1;
export const EXIT_BROKEN = 2;

/**
 * What to exit with.
 *
 * "Found something" and "could not look" are opposite outcomes, so they cannot share a code: a
 * caller unable to tell them apart either ignores real findings or alarms on healthy runs. Note
 * that 1 is a NORMAL outcome here — this command succeeding at its job is not an error.
 */
export function exitCodeFor(r: WatchReport): number {
  // A screen truncated down to nothing observed nothing, so it cannot claim quiet either.
  if (r.errors.length > 0 || (r.truncated && r.fingerprints === 0))
    return EXIT_BROKEN;
  if (
    r.enforcement.length > 0 ||
    r.findings.some((f) => f.advice.verdict === 'ban')
  )
    return EXIT_FOUND;
  return EXIT_QUIET;
}

/** True when a human should look. Separate from the exit code so the two cannot disagree. */
export function isActionable(r: WatchReport): boolean {
  return (
    // Truncated AND empty cannot be told apart from genuinely quiet, so it escalates. Truncated
    // with findings does not: we saw something, and saying so every run is how a watch gets muted.
    (r.truncated && r.fingerprints === 0) ||
    // Errors count. Exit 0 tells a loop to go back to sleep, so a watch that could not read its
    // own inputs must not report quiet — unknown escalates, it does not pass.
    r.errors.length > 0 ||
    r.enforcement.length > 0 ||
    r.findings.some((f) => f.advice.verdict === 'ban')
  );
}

/** The whole report as lines. Pure, so the case that matters — a scraper found — is exercisable without one existing. */
export function watchLines(r: WatchReport): Line[] {
  const L: Line[] = [
    line(
      seg(`Watch — ${r.window.label}`, 'bold'),
      seg(
        `  (${r.window.fromISO.slice(0, 16)}Z → ${r.window.toISO.slice(0, 16)}Z)`,
        'dim',
      ),
    ),
  ];
  for (const e of r.errors) L.push(line(seg(`  ${e}`, 'warn')));
  if (r.truncated)
    L.push(
      line(
        seg(
          `  the screen hit the ${GROUP_CAP}-group cap — impersonation rows may have been dropped`,
          'warn',
        ),
      ),
    );
  L.push(
    blank(),
    line(
      `${r.screened} request(s) classified browser_impersonation reached the app, across ${r.fingerprints} fingerprint(s)`,
    ),
    line(
      seg(
        `  ${r.candidates} above the volume floor and not already denied`,
        r.candidates ? 'warn' : 'good',
      ),
    ),
  );
  for (const f of r.findings) {
    const bad = f.advice.verdict === 'ban';
    L.push(
      blank(),
      line(
        seg(f.advice.verdict.toUpperCase().padEnd(7), bad ? 'bad' : 'dim'),
        seg(f.digest, bad ? 'key' : 'dim'),
        seg(`  ${f.allowed} allowed of ${f.total} total`, 'dim'),
      ),
    );
    if (f.advice.lever)
      L.push(
        line(
          seg('  lever    ', 'bad'),
          seg(`${f.advice.lever.kind} ${f.advice.lever.value}`, 'key'),
          seg(
            f.advice.lever.needsAsNumber
              ? '  (needs the AS number — type it when staging)'
              : '  (stage with b in firewall:setup)',
            'dim',
          ),
        ),
      );
    for (const x of f.advice.reasons)
      L.push(line(seg('  evidence ', 'dim'), seg(x, 'dim')));
    for (const x of f.advice.blockers)
      L.push(line(seg('  blocker  ', 'good'), seg(x, 'dim')));
    for (const x of f.advice.leverNotes.slice(0, 2))
      L.push(line(seg('  note     ', 'warn'), seg(x, 'dim')));
  }
  if (r.enforcement.length) {
    L.push(blank(), line(seg('ENFORCEMENT', 'bold')));
    for (const e of r.enforcement) L.push(line(seg(`  ${e}`, 'bad')));
  }
  if (!isActionable(r))
    L.push(blank(), line(seg('nothing wants a human', 'good')));
  return L;
}

/**
 * Which screened digests are worth the cost of a full profile: enough volume to be judgeable,
 * not already denied, and capped so a classification change cannot trigger a query storm.
 */
export function worthProfiling(
  rows: Screened[],
  denied: string[],
  floor = screenFloor(),
  cap = MAX_PROFILES,
): Screened[] {
  const already = new Set(denied.map((d) => JA4_DENY.normalize(d)));
  return rows
    .filter(({ digest, allowed }) => {
      if (!digest || digest === '(none)') return false;
      if (allowed < floor) return false;
      return !already.has(JA4_DENY.normalize(digest));
    })
    .slice(0, cap);
}

/**
 * Deny rules that are present but not actually denying — the state that reads as handled while
 * traffic is served normally.
 *
 * `values: null` means the denylist could not be READ. That is not the same as empty, and
 * collapsing the two is the exact defect this tool exists to catch elsewhere: an unreadable
 * list scored 0, 0 is the revoked resting state, and a broken rule went unreported.
 */
export function notEnforcing(
  rules: {
    name: string;
    active: boolean;
    action: string;
    values: number | null;
  }[],
): string[] {
  return rules.flatMap((r) => {
    if (r.values === null)
      return [
        `${r.name}: its denylist could not be read, so whether it is enforcing anything is UNKNOWN — not empty`,
      ];
    if (r.values === 0) return []; // revoked is the intended resting state
    if (r.active && r.action === 'deny') return [];
    return [
      `${r.name} carries ${r.values} entr${r.values === 1 ? 'y' : 'ies'} but is ${r.active ? `set to ${r.action}` : 'DEACTIVATED'} — nothing it lists is being blocked`,
    ];
  });
}

/**
 * Screen the window and adjudicate whatever clears the floor. Shared by the CLI and the TUI's
 * watch mode so there is one definition of what counts as suspicious, not two that drift.
 */
export async function findSuspects(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
  deniedJa4: string[],
  trustedAllowRules?: string[],
  /** Verified crawlers we want. Undefined = every verified one is exempt, as before the list. */
  allowedBots?: string[],
): Promise<{ rows: Screened[]; findings: Finding[]; truncated: boolean }> {
  const { rows, truncated } = await screen(creds, window, allowedBots);
  const findings: Finding[] = [];
  const candidates = worthProfiling(rows, deniedJa4);
  // Fetched once, and only when there is something to size — an extra query per run buys nothing
  // on the quiet nights, which is nearly all of them.
  const windowTotal = candidates.length
    ? await windowTotalOf(creds, window)
    : Number.NaN;
  for (const c of candidates) {
    const p = await fetchIpProfile(
      creds,
      { kind: 'ja4', value: c.digest },
      window,
    );
    const advice = adviseBan({
      total: p.total,
      mix: p.mix,
      shape: p.shape,
      ja4: p.byJa4,
      asns: p.byAsn,
      botVerified: p.byBotVerified,
      wafActions: p.byWafAction,
      wafRules: p.byWafRule,
      statuses: p.byStatus,
      digestReach: p.digestReach,
      asnReach: p.asnReach,
      alreadyDeniedJa4: false, // filtered out by worthProfiling
      stagedJa4: false,
      alreadyDeniedAsn: false,
      windowMinutes: p.windowHours * 60,
      failedQueries: p.failedQueries,
      trustedAllowRules,
      mixPartial: p.mixPartial,
      verifiedBots: p.verifiedBots,
      allowedBots,
    });
    findings.push({
      ...c,
      total: p.total,
      advice,
      autoBanRefusal: autoBanRefusal(
        banCandidate({
          digest: c.digest,
          advice,
          reach: p.digestReach,
          total: p.total,
          windowTotal,
        }),
      ),
    });
  }
  return { rows, findings, truncated };
}

/**
 * One screen with every gate the advisory needs, each read fresh.
 *
 * Both entrypoints go through here. They used to assemble these arguments separately and drifted
 * three times — the TUI lost the first-party blocker, then the truncation flag, then the bot
 * allowlist — and every time it was the UNATTENDED path that lost the signal. Divergence is the
 * defect, so the assembly is the thing that had to be shared, not the call.
 *
 * Config failures are collected, never thrown: each degrades to the permissive value, and the
 * CALLER decides what a missing gate means. Returned rather than logged so neither entrypoint
 * can quietly ignore them — the CLI escalates them to exit 2, the TUI shows them.
 */
export async function screenOnce(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
): Promise<{
  rows: Screened[];
  findings: Finding[];
  truncated: boolean;
  configErrors: string[];
}> {
  const configErrors: string[] = [];

  // Not required: an unreadable denylist means nothing is known to be already-denied, which only
  // ever makes the screen wider.
  let denied: string[] = [];
  try {
    denied = envMatching('FW_BLOCKED_JA4', JA4_DENY, false);
  } catch (e) {
    configErrors.push(`FW_BLOCKED_JA4 unreadable: ${errMsg(e)}`);
  }

  // Read fresh, not cached at startup: a rule edited in the dashboard hours into a watch is the
  // exact drift rule-integrity exists to notice.
  let trusted: string[] | undefined;
  try {
    const { fetchLive } = await import('./client');
    const { rules } = await import('./rules');
    trusted = trustedRules((await fetchLive()).headerKeysByName, rules);
  } catch (e) {
    configErrors.push(`live firewall config: ${errMsg(e)}`);
  }

  // Undefined on failure, which exempts EVERY verified crawler — the pre-allowlist behaviour.
  // The permissive direction is the safe one here: a config that failed to load must never turn
  // Googlebot into a ban candidate.
  let allowed: string[] | undefined;
  try {
    allowed = allowedBots();
  } catch (e) {
    configErrors.push(`FW_ALLOWED_BOTS: ${errMsg(e)}`);
  }

  const found = await findSuspects(creds, window, denied, trusted, allowed);
  return { ...found, configErrors };
}

const IMPERSONATION = 'browser_impersonation';
/** The observability group cap. A response at this size may have dropped rows we wanted. */
const GROUP_CAP = 500;
// What reached the app, expressed as what did NOT stop it — a request arrives as log, allow or
// bypass depending on configuration, and naming one of them misses the rest.
const PASSED = "wafAction ne 'deny' and wafAction ne 'challenge'";

/**
 * Pick the impersonation rows out of a two-dimension summary, busiest first.
 *
 * Separate from the query because `botCategory` cannot be filtered on — see `screen` — so the
 * selection happens here, and a selection that silently matches nothing is the failure this whole
 * tool exists to notice.
 */
export function impersonators(summary: Row[]): Screened[] {
  // Deliberately uncapped. `worthProfiling` bounds the expensive work, but it does so AFTER
  // dropping what is already denied — so a cap here would run first, and with the busiest
  // fingerprints denied, which is exactly what a working denylist produces, everything still
  // eligible sits below the cut and is never looked at. The result is bounded by the group cap
  // regardless.
  return (
    summary
      .filter((r) => String(r.botCategory ?? '') === IMPERSONATION)
      .map((r) => ({
        // Lower-cased here, where the value enters, because `fetchIpProfile` validates the
        // lower-cased digest but filters on the raw one. An upper-cased digest would pass
        // validation and then match nothing — an empty profile that reads as a quiet identity
        // rather than as a query that never looked.
        digest: String(r.clientJa4Digest ?? '').toLowerCase(),
        allowed: countOf(r),
        why: ['Vercel classified it as impersonating a browser'],
      }))
      // A row with no digest is dropped, not renamed. Substituting a placeholder would clear the
      // volume floor and be profiled as if it were a fingerprint — ~21 queries spent on an
      // identity that does not exist, counted in the report as a candidate.
      .filter(({ digest }) => digest && digest !== '(none)' && digest !== '?')
      .sort((a, b) => b.allowed - a.allowed)
  );
}

/**
 * The digests Vercel classified as impersonating a browser and then allowed through.
 *
 * `botCategory` is a groupBy dimension, NOT a filter field: `botCategory eq '…'` returns zero
 * rows with no error, which is indistinguishable from a quiet window and is why this screen
 * reported nothing from the day it shipped. Only `wafAction` is filtered — that one works — and
 * the category is selected from the result.
 */
export async function screen(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
  /** Verified crawlers to keep off the candidate list. Undefined = skip every verified one. */
  allowed?: readonly string[],
): Promise<{ rows: Screened[]; truncated: boolean }> {
  const { ctx } = makeCtx(creds, window);
  const [routeResp, verifiedResp] = await Promise.all([
    metrics(ctx, ['clientJa4Digest', 'route'], {
      filter: PASSED,
      limit: GROUP_CAP,
    }),
    // botName joined in: the exclusion is now by NAME, not by the bare verified flag. Measured
    // 2026-08-08 — botVerified survives this join intact (pass totals matched the single-dimension
    // query exactly), unlike the botCategory join it is documented to collapse in.
    metrics(ctx, ['clientJa4Digest', 'botVerified', 'botName'], {
      filter: PASSED,
      limit: GROUP_CAP,
    }),
  ]);
  const resp = await metrics(ctx, ['clientJa4Digest', 'botCategory'], {
    // What reached the app, expressed as what did NOT stop it. Measured 2026-08-06: requests
    // arrive as `log`, `allow` or `bypass` depending on how the ruleset is configured and which
    // rules matched, and a filter naming only one of those silently misses the rest — an
    // observe-only ruleset serves everything as `log`, where `wafAction eq 'allow'` would have
    // seen a fraction of a percent of the traffic and called the window quiet.
    filter: PASSED,
    limit: GROUP_CAP,
  });
  const summary = resp.summary ?? [];
  const routeRows = routeResp.summary ?? [];
  const verifiedRows = verifiedResp.summary ?? [];
  // A capped verification response can omit a confirmed crawler, and the behavioural screen would
  // then surface it as a candidate purely because we failed to learn it was legitimate. Better to
  // run only the category screen and say the window was truncated than to invent a suspect.
  const verifiedComplete = verifiedRows.length < GROUP_CAP;
  return {
    // Both screens, merged. The category screen carries Vercel's own judgement; the behavioural
    // one sees what Vercel never classified, which is where anything that evaded it will sit.
    rows: mergeScreens(
      impersonators(summary),
      verifiedComplete
        ? nonRendering(routeRows, verifiedDigests(verifiedRows, allowed))
        : [],
    ),
    // Because `botCategory` cannot be filtered, busy non-impersonation groups compete for the
    // same 500 slots — so a capped response can have dropped the very rows this screen exists to
    // find, and would then report a quiet window.
    truncated:
      summary.length >= GROUP_CAP ||
      routeRows.length >= GROUP_CAP ||
      !verifiedComplete,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const raw = argv.find((a) => !a.startsWith('--'));
  const hours = raw === undefined ? watchHours() : Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
    throw new Error(`hours must be an integer from 1 to ${MAX_HOURS}`);

  const creds = resolveVercelCredentials();
  const window = rollingWindow(hours, new Date());
  const errors: string[] = [];

  const { rows, findings, truncated, configErrors } = await screenOnce(
    creds,
    window,
  );
  errors.push(...configErrors);
  await logShadow(process.cwd(), findings);

  const report: WatchReport = {
    window,
    screened: rows.reduce((n, r) => n + r.allowed, 0),
    fingerprints: rows.length,
    candidates: findings.length,
    truncated,
    findings,
    // Cheap and unrelated to the screen: a deny rule that stopped denying reads as handled
    // while the traffic it lists is served normally.
    enforcement: await enforcementIssues(),
    errors,
  };
  console.log(
    toAnsi(watchLines(report), {
      colour: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    }),
  );

  // --notify is for the unattended path: nobody is reading stdout, so the only way a finding
  // reaches a human is if it goes and finds them. Only on a CHANGE, or an hourly repeat of the
  // same finding trains you to dismiss it.
  // --investigate spends money, so it is opt-in and heavily gated. The advisory's `ban` is the
  // bar to START one; what gets a human out of bed is what the investigation CONCLUDES.
  const concluded: string[] = [];
  if (argv.includes('--investigate')) {
    const now = Date.now();
    // Persisted across runs, because an hourly job has no memory of its own and the same
    // fingerprint is still there next hour. Without this it buys the same answer every time.
    const seen = await readInvestigated(process.cwd(), now);
    for (const f of investigable(report.findings, seen)) {
      seen.set(f.digest.toLowerCase(), now);
      const out = await runInvestigation(f, process.cwd());
      const verdict = out.ok ? verdictFrom(out.verdict) : 'unclear';
      await logWatch(
        process.cwd(),
        new Date(),
        out.ok
          ? {
              kind: 'verdict',
              digest: f.digest,
              text: out.verdict,
              provenance: out.provenance,
            }
          : { kind: 'failed', digest: f.digest, error: out.error },
      );
      // `unclear` reaches a human too: an investigation that ran and cannot be read is a result
      // nobody has seen, which is not the same as one that came back clean.
      if (verdict !== 'leave')
        concluded.push(`${verdict}:${f.digest.toLowerCase()}`);
      console.log(`  investigated ${f.digest} -> ${verdict}`);
    }
    // Written even if a notification later fails: the money is already spent either way.
    await writeInvestigated(process.cwd(), seen);
  }

  // What is worth a message: the investigation's conclusion when there was one, otherwise the
  // report itself. Asking for --investigate means you want Claude's answer, not the screen's.
  if (argv.includes('--notify')) {
    const investigated = argv.includes('--investigate');
    const key = investigated ? concludedKey(concluded) : actionableKey(report);
    if (await shouldNotify(process.cwd(), key)) {
      const failed = await notify(
        investigated ? concludedText(concluded) : notifyText(report),
      );
      // Only remember it as delivered if it was. Otherwise the next run would treat the same
      // finding as already reported and stay quiet about something nobody has seen.
      if (failed) console.error(`  ${failed}`);
      else await rememberNotified(process.cwd(), key);
    }
  }
  process.exitCode = exitCodeFor(report);
}

/** Deferred so the observability-only path does not pay for the firewall config read. */
async function enforcementIssues(): Promise<string[]> {
  const { fetchLive } = await import('./client');
  const live = await fetchLive();
  // null, never 0, when the list cannot be parsed — see notEnforcing.
  const count = (name: string, spec: typeof JA4_DENY): number | null => {
    try {
      return envMatching(
        name === 'deny-scraper-ja4' ? 'FW_BLOCKED_JA4' : 'FW_BLOCKED_ASN',
        spec,
        false,
      ).length;
    } catch {
      return null;
    }
  };
  return notEnforcing(
    (
      [
        ['deny-scraper-ja4', JA4_DENY],
        ['deny-scraper-asn', ASN_DENY],
      ] as const
    ).map(([name, spec]) => ({
      name,
      active: live.activeByName.get(name) ?? false,
      action: live.actionByName.get(name) ?? 'log',
      values: count(name, spec),
    })),
  );
}

if (import.meta.main)
  main().catch((error) => {
    console.error('firewall:watch failed:', errMsg(error));
    // Not 1. Failing to start is a failure to LOOK, and 1 is reserved for having looked and found
    // something — the whole distinction these codes exist for.
    process.exit(EXIT_BROKEN);
  });
