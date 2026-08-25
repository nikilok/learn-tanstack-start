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
  recommendsAction,
  sustainedByDuration,
} from './ban-advice';
import { resolveVercelCredentials } from './credentials';
import { ASN_DENY, JA4_DENY, UA_DENY, envMatching } from './deny-list';
import { useColour } from './env';
import { fetchIpProfile } from './ip-profile';
import { mixOf, renderingRequests } from './ip-signals';
import {
  type KinFamily,
  type KinReport,
  type Standing,
  buildKinReport,
} from './kin-report';
import { type Line, blank, line, seg, toAnsi } from './line-model';
import { type Row, countOf, makeCtx, metrics } from './observability';
import { bypassPaths, reachabilityFindings } from './reachability';
import { trustedRules } from './rule-integrity';
import { isRecoverableRule } from './rule-names';
import { type Window, rollingWindow } from './time-window';
import {
  allowedBots,
  screenFloor,
  sustainedDutyOrUnknown,
  watchHours,
} from './tuning';
import { errMsg } from './util';
import { logWatch } from './watch-log';
import {
  investigable,
  runInvestigation,
  verdictFrom,
  fingerprintConfig,
  investigationChangedConfig,
} from './watch-mode';
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
import {
  IGNORELIST_FILE,
  WATCHLIST_FILE,
  type WatchAddition,
  readList,
  recordAdditions,
} from './watchlist';

const MAX_HOURS = 24 * 6; // the free observability window
// A profile is expensive; a screen that suddenly matches everything means the category changed,
// not that the site is under attack from fifty actors at once.
const MAX_PROFILES = 6;
// Members shown inline under a finding. The full line is one command away, and a finding that
// scrolls its own verdict off the screen is worse than a short one.
const MAX_BUILD_LINE = 4;

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
 * traffic rather than a threshold anyone had to tune: the two populations separate by more than
 * an order of magnitude, with nothing in between.
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

/** The build line a digest sits on, with the digest itself removed, or undefined when it is on none. */
function lineFor(
  report: KinReport | null,
  digest: string,
): KinFamily | undefined {
  const d = JA4_DENY.normalize(digest);
  const family = report?.families.find((f) =>
    f.members.some((m) => m.digest === d),
  );
  if (!family) return undefined;
  const members = family.members.filter((m) => m.digest !== d);
  return members.length ? { ...family, members } : undefined;
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
  /**
   * The TLS build line this identity sits on, when something on it is already denied or
   * challenged — the other members, minus this one.
   *
   * Attribution, not detection: the screen found this identity on its own evidence. This only
   * says whether it is a rebuild of something already acted on, which changes the TIER — the
   * decision that actually went wrong the last time this actor rotated.
   */
  buildLine?: KinFamily;
  /** The profile came back empty for an identity the screen saw traffic from — the advisory judged nothing, so its verdict says nothing. */
  profileEmpty: boolean;
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

/** The first thing that decided the advice — a blocker outranks evidence, evidence outranks a ruled-out lever. */
export function adviceWhy(a: Advice): string {
  return a.blockers[0] ?? a.reasons[0] ?? a.leverNotes[0] ?? '';
}

/** The advice as one log-friendly line: the verdict plus what decided it. */
export function adviceSummary(a: Advice): string {
  const why = adviceWhy(a);
  return why ? `${a.verdict} — ${why}` : a.verdict;
}

/** What a run contributes to the watch list: every profiled identity, whatever the verdict — "who was that?" is exactly the question the list exists to answer. */
export function watchlistAdditions(
  findings: readonly Finding[],
): WatchAddition[] {
  return findings.map((f) => ({
    kind: 'ja4' as const,
    id: f.digest,
    source: 'watch' as const,
    note: `${adviceSummary(f.advice)}${f.why.length ? ` · screen: ${f.why[0]}` : ''}`,
  }));
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
  deps: ScreenDeps = LIVE_DEPS,
): Promise<number> {
  try {
    const { ctx } = makeCtx(creds, window);
    const rows = (await deps.metrics(ctx, ['wafAction'], { limit: GROUP_CAP }))
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
  /** Exempted paths that answered only mitigations — an allow rule that stopped allowing. */
  reachability: string[];
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
    r.reachability.length > 0 ||
    r.findings.some((f) => recommendsAction(f.advice.verdict))
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
    r.reachability.length > 0 ||
    r.findings.some((f) => recommendsAction(f.advice.verdict))
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
        `  ${r.candidates} above the volume floor and not already handled (denied, challenged, name-banned or ignored)`,
        r.candidates ? 'warn' : 'good',
      ),
    ),
  );
  for (const f of r.findings) {
    const acts = recommendsAction(f.advice.verdict);
    // The recoverable tier reads as a warning, not an alarm. Colouring it the same red as a deny
    // trains the eye to skim both, and the whole point of the tier is that it is the lesser call.
    const tone =
      f.advice.verdict === 'ban'
        ? 'bad'
        : f.advice.verdict === 'challenge'
          ? 'warn'
          : 'dim';
    L.push(
      blank(),
      line(
        seg(f.advice.verdict.toUpperCase().padEnd(9), tone),
        seg(f.digest, acts ? 'key' : 'dim'),
        seg(`  ${f.allowed} allowed of ${f.total} total`, 'dim'),
      ),
    );
    if (f.profileEmpty)
      L.push(
        line(
          seg(
            '  UNJUDGED  the profile returned nothing for an identity the screen saw traffic from — the verdict above was reached on no evidence',
            'bad',
          ),
        ),
      );
    if (f.buildLine) {
      // Under the finding, because it is about THIS identity's tier. The evidence a member
      // contributes is censored by whatever we already did to it, so the line says which.
      L.push(
        line(
          seg('  build line', 'warn'),
          seg(` ${f.buildLine.family}_*`, 'key'),
          seg(
            f.buildLine.standing === 'denied'
              ? ' — a member is DENIED, so its traffic never reaches routing and the shares below cannot see it'
              : ' — a member is CHALLENGED, so a browser meeting the interstitial renders nothing here',
            'dim',
          ),
        ),
      );
      for (const m of f.buildLine.members.slice(0, MAX_BUILD_LINE))
        L.push(
          line(
            seg(`      ${m.digest}`, 'dim'),
            seg(`  ${String(m.requests).padStart(6)} req`, 'dim'),
            seg(`  ${(m.renderShare * 100).toFixed(1).padStart(5)}%`, 'dim'),
            seg(
              m.verified
                ? '  verified crawler'
                : m.renderShare > 0.05
                  ? '  renders — a browser'
                  : '  renders nothing',
              m.verified || m.renderShare > 0.05 ? 'good' : 'bad',
            ),
            m.standing ? seg(`  [${m.standing}]`, 'dim') : seg(''),
          ),
        );
      if (f.buildLine.members.length > MAX_BUILD_LINE)
        L.push(
          line(
            seg(
              `      … +${f.buildLine.members.length - MAX_BUILD_LINE} more — bun run firewall:kin`,
              'dim',
            ),
          ),
        );
    }
    if (f.advice.lever)
      L.push(
        line(
          seg('  lever    ', tone === 'dim' ? 'warn' : tone),
          seg(`${f.advice.lever.kind} ${f.advice.lever.value}`, 'key'),
          seg(
            f.advice.lever.needsAsNumber
              ? '  (needs the AS number — type it when staging)'
              : `  (${f.advice.lever.tier === 'challenge' ? 'FW_CHALLENGE_JA4' : 'FW_BLOCKED_JA4'}; stage with b in firewall:setup)`,
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
  if (r.reachability.length) {
    L.push(blank(), line(seg('REACHABILITY', 'bold')));
    for (const e of r.reachability) L.push(line(seg(`  ${e}`, 'bad')));
  }
  if (r.enforcement.length) {
    L.push(blank(), line(seg('ENFORCEMENT', 'bold')));
    for (const e of r.enforcement) L.push(line(seg(`  ${e}`, 'bad')));
  }
  if (!isActionable(r))
    L.push(blank(), line(seg('nothing wants a human', 'good')));
  return L;
}

/** How long each digest was present for. Measured by the screen, which knows nothing of tuning. */
export type Presence = {
  /** Buckets each digest actually sent something in, keyed by NORMALISED digest. */
  activeBuckets: ReadonlyMap<string, number>;
  bucketMinutes: number;
  windowMinutes: number;
};

/** Presence plus the threshold it is judged against, which only a tuning reader can supply. */
export type Persistence = Presence & { duty: number };

/**
 * Buckets in which each digest actually sent something, keyed by normalised digest.
 *
 * The observability API ZERO-FILLS: every group gets a row at every bucket, so a response's row
 * count is groups times buckets and counting rows would report every identity as present
 * throughout. Only a non-zero measure counts as presence. Getting this wrong does not fail
 * loudly — it makes the persistence gate clear for everyone, which is the direction that spends
 * profiles on the whole window and admits identities nothing has established anything about.
 */
export function activeBucketsByDigest(
  responses: readonly { data?: Row[] }[],
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const resp of responses)
    for (const r of resp.data ?? []) {
      if (countOf(r) <= 0) continue;
      const raw = String(r.clientJa4Digest ?? '');
      if (!raw || raw === '(none)' || raw === '?') continue;
      const t = String(r.timestamp ?? '');
      if (!t) continue;
      const d = JA4_DENY.normalize(raw);
      const at = seen.get(d);
      if (at) at.add(t);
      else seen.set(d, new Set([t]));
    }
  return new Map([...seen].map(([d, at]) => [d, at.size]));
}

/**
 * Which screened digests are worth the cost of a full profile: judgeable, not already denied, and
 * capped so a classification change cannot trigger a query storm.
 *
 * Judgeable means enough volume OR enough duration. The floor alone made a self-paced client
 * permanently invisible: it scales per day, so a client staying under it is under it at every
 * window, and the loop dropped it before the profile every tick forever. `sustainedByDuration`
 * answers the same question from presence instead, and it is the ONLY thing this adds — a
 * candidate admitted that way still faces every blocker, both axes and the reach test unchanged.
 *
 * `persistence` omitted means no series was read, which is not the same as nothing being
 * persistent: it falls back to the volume floor alone, the behaviour before this existed.
 */
export function worthProfiling(
  rows: Screened[],
  denied: string[],
  floor: number,
  persistence?: Persistence,
  cap = MAX_PROFILES,
): Screened[] {
  const already = new Set(denied.map((d) => JA4_DENY.normalize(d)));
  const sustained = ({ digest, allowed }: Screened): boolean =>
    persistence !== undefined &&
    sustainedByDuration(
      persistence.activeBuckets.get(JA4_DENY.normalize(digest)) ?? 0,
      persistence.bucketMinutes,
      persistence.windowMinutes,
      allowed,
      persistence.duty,
    );
  return (
    rows
      .filter((r) => {
        if (!r.digest || r.digest === '(none)') return false;
        if (r.allowed < floor && !sustained(r)) return false;
        return !already.has(JA4_DENY.normalize(r.digest));
      })
      // Said on the candidate itself, because "why is this here on 137 requests" is the first
      // question the finding has to answer and the floor is no longer the whole story.
      .map((r) =>
        r.allowed < floor
          ? {
              ...r,
              why: [
                ...r.why,
                'under the volume floor but present across most of the window',
              ],
            }
          : r,
      )
      .slice(0, cap)
  );
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
    /** What this rule is supposed to be doing. A challenge tier set to `deny` is not "enforcing". */
    expected?: string;
  }[],
): string[] {
  return rules.flatMap((r) => {
    if (r.values === null)
      return [
        `${r.name}: its denylist could not be read, so whether it is enforcing anything is UNKNOWN — not empty`,
      ];
    if (r.values === 0) return []; // revoked is the intended resting state
    const expected = r.expected ?? 'deny';
    if (r.active && r.action === expected) return [];
    const entries = `${r.values} entr${r.values === 1 ? 'y' : 'ies'}`;
    // Direction matters. Reporting an ESCALATION as under-enforcement is worse than saying
    // nothing: a challenge tier drifted to `deny` is hard-blocking unproven digests, and an
    // operator who reads that as a revoked-looking rule leaves the outage running.
    if (r.active && expected === 'challenge' && r.action === 'deny')
      return [
        `${r.name} carries ${entries} and has been ESCALATED from challenge to DENY — every one of them is now hard-blocked, including anyone sharing those fingerprints. Nothing should set this rule to deny; put it back to challenge.`,
      ];
    return [
      `${r.name} carries ${entries} but is ${r.active ? `set to ${r.action}, not ${expected}` : 'DEACTIVATED'} — nothing it lists is being ${expected === 'challenge' ? 'challenged' : 'blocked'}`,
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
  /**
   * Digests on FW_CHALLENGE_JA4. Required rather than defaulted: it taints the reach (see the
   * censorship note in `adviseBan`), and an omitted list reads as "nothing is challenged", which
   * is the direction that clears a deny on evidence this tool suppressed.
   */
  challengedJa4: readonly string[],
  trustedAllowRules?: string[],
  /** Verified crawlers we want. Undefined = every verified one is exempt, as before the list. */
  allowedBots?: string[],
  /** User-agent tokens already denied at the WAF. */
  deniedUa: readonly string[] = [],
  /** Operator-curated noise: never profiled, so never recorded, logged, or displayed. */
  ignoredJa4: readonly string[] = [],
  deps: ScreenDeps = LIVE_DEPS,
  /**
   * FW_SUSTAINED_DUTY_PCT, as a fraction. Undefined means it could not be read, and the gate then
   * does not fire at all — the volume floor governs alone, exactly as before it existed. Last and
   * optional so the many test call sites that predate it keep the old behaviour by construction.
   */
  sustainedDuty?: number,
): Promise<{
  rows: Screened[];
  findings: Finding[];
  truncated: boolean;
  /** Build lines of everything already denied or challenged, or null when the sample capped. Attached to findings; never a finding of its own. */
  kinReport: KinReport | null;
}> {
  // Built from this function's OWN parameters, so the screen never reads the environment and a
  // replay can drive the whole assembly. Denied last: a digest on both lists is denied in effect.
  const standings = new Map<string, Standing>([
    ...challengedJa4.map((x) => [JA4_DENY.normalize(x), 'challenged'] as const),
    ...deniedJa4.map((x) => [JA4_DENY.normalize(x), 'denied'] as const),
  ]);
  const { rows, truncated, handled, presence, kinReport } = await screen(
    creds,
    window,
    allowedBots,
    deniedUa,
    deps,
    standings,
  );
  // The screen measures presence; only a tuning reader knows what share counts as sustained.
  const persistence =
    sustainedDuty === undefined
      ? undefined
      : { ...presence, duty: sustainedDuty };
  const findings: Finding[] = [];
  // Both levers, the challenge tier, and the ignore list. An identity denied by either lever is
  // handled, and profiling it again spends ~21 queries — and, unattended, a paid investigation —
  // to rediscover a ban already in place. An IGNORED identity is the operator saying the same
  // about a first-party or otherwise-known caller: skip it before the spend, not after.
  //
  // CHALLENGED digests are dropped here by operator decision (2026-08-12). A mitigation is in
  // place, so re-surfacing the digest every tick recommends an action already taken — the finding
  // even said "stage with b" for something already applied, which invites applying it twice.
  //
  // The cost, recorded because it is real and was argued before the call was made: if a challenged
  // client DEFEATS the challenge, the loop no longer says so. That is the same bargain the ignore
  // list makes, and it gets the same mitigations — the digest still counts in the aggregate
  // "reached the app" figure above, so a mitigation failing at volume still moves a number on
  // screen, and `o` on the watch-list entry profiles it on demand. Verify a challenge by looking
  // for ALLOWED traffic on the digest (`wafAction ne 'deny' and ne 'challenge'`), which is a
  // direct query, not something this screen was ever the right place to infer.
  const candidates = worthProfiling(
    rows,
    [...deniedJa4, ...handled, ...ignoredJa4, ...challengedJa4],
    screenFloor(window.minutes),
    persistence,
  );
  // Fetched once, and only when there is something to size — an extra query per run buys nothing
  // on the quiet nights, which is nearly all of them.
  const windowTotal = candidates.length
    ? await windowTotalOf(creds, window, deps)
    : Number.NaN;
  for (const c of candidates) {
    const p = await deps.fetchIpProfile(
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
      // ALWAYS false on this path, and deliberately still computed.
      //
      // The comment here used to claim the opposite — that a challenged digest reaching the
      // advisory had defeated its challenge — and that was true until `worthProfiling` began
      // filtering the same list a few hours later. A comment asserting the reverse of the code is
      // worse than none, so: `challengedJa4` and the profiling filter read the SAME list, which is
      // what makes this always false rather than merely usually.
      //
      // Kept because it is the only thing standing between a future edit and a silent hole: drop
      // the suppression from `worthProfiling` and the censorship guard has to work immediately,
      // without anyone remembering to re-wire it. The guard itself is exercised by the on-demand
      // paths — `firewall:ip` and the TUI profile — which is where an operator actually reads it.
      challengedJa4: challengedJa4
        .map(JA4_DENY.normalize)
        .includes(JA4_DENY.normalize(c.digest)),
      stagedJa4: false,
      alreadyDeniedAsn: false,
      windowMinutes: p.windowHours * 60,
      failedQueries: p.failedQueries,
      trustedAllowRules,
      rpcsPartial: p.rpcsPartial,
      mixPartial: p.mixPartial,
      verifiedBots: p.verifiedBots,
      allowedBots,
      sustainedDuty,
    });
    findings.push({
      ...c,
      total: p.total,
      advice,
      // The screen SAW this identity's traffic; the profile then reported none of it. Those two
      // cannot both be true, so the queries behind the profile did not answer — and every axis the
      // advisory weighed was weighed on nothing. Its verdict is not a reading of this identity.
      //
      // Live, that is a failed query degrading to []. Under --mock it is a cassette that never
      // recorded this identity, which is the common case: a recording holds only what was opened.
      profileEmpty: p.total === 0 && c.allowed > 0,
      autoBanRefusal: autoBanRefusal(
        banCandidate({
          digest: c.digest,
          advice,
          reach: p.digestReach,
          total: p.total,
          windowTotal,
        }),
      ),
      // Free: assembled from summaries the screen already fetched. The digest itself is dropped —
      // a line listing the identity it is attached to reads as if it were its own sibling.
      buildLine: lineFor(kinReport, c.digest),
    });
  }
  return { rows, findings, truncated, kinReport };
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
  deps: ScreenDeps = LIVE_DEPS,
  /** Where the operator's list files live. Injectable so tests never read the real ones. */
  dir: string = process.cwd(),
): Promise<{
  rows: Screened[];
  findings: Finding[];
  truncated: boolean;
  /** Build lines of everything already denied or challenged, or null when the sample capped. Attached to findings; never a finding of its own. */
  kinReport: KinReport | null;
  configErrors: string[];
}> {
  const configErrors: string[] = [];

  // Curated noise. Unreadable means NOTHING is ignored — the screen only ever widens, and the
  // noise coming back is what tells the operator the file needs fixing, alongside the error.
  let ignored: string[] = [];
  {
    const list = await readList(dir, IGNORELIST_FILE);
    if (list.ok)
      ignored = list.entries.filter((e) => e.kind === 'ja4').map((e) => e.id);
    else configErrors.push(list.error ?? `${IGNORELIST_FILE} unreadable`);
  }

  // Not required: an unreadable denylist means nothing is known to be already-denied, which only
  // ever makes the screen wider.
  let denied: string[] = [];
  try {
    denied = envMatching('FW_BLOCKED_JA4', JA4_DENY, false);
  } catch (e) {
    configErrors.push(`FW_BLOCKED_JA4 unreadable: ${errMsg(e)}`);
  }
  // Read separately from `denied`, and used for two different things.
  //
  // 1. It SUPPRESSES the digest from the screen (operator decision 2026-08-12 — see the note at
  //    the `worthProfiling` call, which records what that costs).
  // 2. It taints the advice wherever a challenged digest IS profiled, on demand or in the TUI: a
  //    challenged digest's rendering evidence is suppressed BY US, so the advisory must refuse to
  //    clear a deny on the resulting zero.
  //
  // Kept OUT of `denied` rather than folded in, because the two mean different things everywhere
  // else: `already` renders as "denied, the rule is in place", and saying that about a digest that
  // is being interstitialed is a claim the operator would act on. Same fail-safe direction as
  // `denied` — unreadable means the list is empty, so nothing is suppressed and nothing is
  // tainted, and the failure is reported rather than swallowed.
  let challenged: string[] = [];
  try {
    challenged = envMatching('FW_CHALLENGE_JA4', JA4_DENY, false);
  } catch (e) {
    configErrors.push(`FW_CHALLENGE_JA4 unreadable: ${errMsg(e)}`);
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

  // Read like the JA4 list: unreadable means "none known", which only widens the screen.
  let deniedUa: string[] = [];
  try {
    deniedUa = envMatching('FW_BLOCKED_UA', UA_DENY, false);
  } catch (e) {
    configErrors.push(`FW_BLOCKED_UA unreadable: ${errMsg(e)}`);
  }

  // Unreadable turns the persistence gate OFF — the opposite direction to the allowlist above,
  // and for the same reason: whichever answer widens nothing is the one an unread config gets.
  // Reported rather than swallowed, because silently reverting to the volume floor would leave a
  // self-paced client invisible again with nothing on screen to say why.
  const duty = sustainedDutyOrUnknown();
  if (duty.error) configErrors.push(`FW_SUSTAINED_DUTY_PCT: ${duty.error}`);
  const found = await findSuspects(
    creds,
    window,
    denied,
    challenged,
    trusted,
    allowed,
    deniedUa,
    ignored,
    deps,
    duty.duty,
  );
  return { ...found, configErrors };
}

/** Share of an identity's traffic a denied name must own before the identity counts as handled. */
const HANDLED_SHARE = 0.5;

/**
 * Fingerprints already denied by NAME, so the screen stops re-nominating them.
 *
 * The screen filters on what PASSED, and a window that mostly predates a ban is still full of
 * the traffic that passed before it. So a UA-denied crawler keeps arriving as a candidate for a
 * whole window: profiled at ~21 queries, and with --investigate, a paid agent spent to conclude
 * it should be denied. It already is.
 *
 * Dominance, not presence. A digest is a client BUILD and can carry several callers; dropping it
 * because 1% of its traffic is a denied bot would blind the screen to the other 99%. Only when
 * the denied name owns the majority is the identity genuinely handled.
 */
export function deniedByUa(
  uaRows: Row[],
  tokens: readonly string[],
  share = HANDLED_SHARE,
): Set<string> {
  const out = new Set<string>();
  if (!tokens.length) return out;
  const total = new Map<string, number>();
  const denied = new Map<string, number>();
  for (const r of uaRows) {
    const digest = JA4_DENY.normalize(String(r.clientJa4Digest ?? ''));
    if (!digest) continue;
    const n = countOf(r);
    total.set(digest, (total.get(digest) ?? 0) + n);
    const ua = String(r.clientUserAgent ?? '');
    if (tokens.some((t) => t && ua.includes(t)))
      denied.set(digest, (denied.get(digest) ?? 0) + n);
  }
  for (const [digest, n] of denied) {
    const all = total.get(digest) ?? 0;
    if (all > 0 && n / all > share) out.add(digest);
  }
  return out;
}

/**
 * The two calls that reach the network, injectable so the ASSEMBLY can be tested.
 *
 * The decision modules beneath this file carry 238 tests between them; `screen`, `findSuspects`
 * and `screenOnce` carried none, because driving them needed production. Every defect found in
 * this package today lived in that gap — four gates present on one path and missing on the
 * other, a truncation flag dropped, a guard applied to the tick but not the reschedule.
 */
export type ScreenDeps = {
  metrics: typeof metrics;
  fetchIpProfile: typeof fetchIpProfile;
};

const LIVE_DEPS: ScreenDeps = { metrics, fetchIpProfile };

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
  /** Denied user-agent tokens, so an identity already banned by name is not re-nominated. */
  deniedUa: readonly string[] = [],
  deps: ScreenDeps = LIVE_DEPS,
  /** Everything already denied or challenged, tagged with which. Passed in rather than read from the environment, so the assembly is drivable from a recorded corpus. */
  standings: Map<string, Standing> = new Map(),
): Promise<{
  rows: Screened[];
  truncated: boolean;
  handled: Set<string>;
  presence: Presence;
  /** Build lines of everything already denied or challenged, or null when the sample capped. Attached to findings; never a finding of its own. */
  kinReport: KinReport | null;
}> {
  const { metrics } = deps;
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
  // Only when there is a name list to check against — otherwise it is a query that can only
  // answer "nothing is handled".
  const uaResp = deniedUa.length
    ? await metrics(ctx, ['clientJa4Digest', 'clientUserAgent'], {
        filter: PASSED,
        limit: GROUP_CAP,
      })
    : undefined;
  const resp = await metrics(ctx, ['clientJa4Digest', 'botCategory'], {
    // What reached the app, expressed as what did NOT stop it. Measured 2026-08-06: requests
    // arrive as `log`, `allow` or `bypass` depending on how the ruleset is configured and which
    // rules matched, and a filter naming only one of those silently misses the rest — an
    // observe-only ruleset serves everything as `log`, where `wafAction eq 'allow'` would have
    // seen a fraction of a percent of the traffic and called the window quiet.
    filter: PASSED,
    limit: GROUP_CAP,
  });
  const uaRows = uaResp?.summary ?? [];
  const uaCapped = uaRows.length >= GROUP_CAP;
  const summary = resp.summary ?? [];
  const routeRows = routeResp.summary ?? [];
  const verifiedRows = verifiedResp.summary ?? [];
  // A capped verification response can omit a confirmed crawler, and the behavioural screen would
  // then surface it as a candidate purely because we failed to learn it was legitimate. Better to
  // run only the category screen and say the window was truncated than to invent a suspect.
  const verifiedComplete = verifiedRows.length < GROUP_CAP;
  // Free: both summaries are already in hand. Null when either capped — a count of zero would
  // read as "nothing on any build line", which a truncated sample cannot support.
  const kinReport =
    routeRows.length < GROUP_CAP && verifiedComplete
      ? buildKinReport(window, routeRows, verifiedRows, standings, true)
      : null;
  return {
    kinReport,
    // Free: these two responses already carry an hourly series per group, and the screen was
    // reading only their summaries. No extra query buys the persistence gate.
    presence: {
      activeBuckets: activeBucketsByDigest([resp, routeResp]),
      // What makeCtx actually asked for, not the window's own granularity — anything from an
      // hour up is bucketed hourly, and a bucket size the series was not built at turns the duty
      // cycle into a number about nothing.
      bucketMinutes:
        window.granularityMinutes < 60 ? window.granularityMinutes : 60,
      windowMinutes: window.minutes,
    },
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
      uaCapped ||
      !verifiedComplete,
    // Folded in like the verified response's. This is the highest-cardinality query in the
    // screen — every distinct user-agent times every digest — and truncation keeps high-count
    // rows while shedding the tail, so on a shared digest the denied crawler's single busy UA
    // survives while hundreds of real browsers behind that TLS build are dropped. `deniedByUa`
    // would then compute a majority from a truncated denominator and call it handled.
    handled: uaCapped
      ? new Set<string>()
      : deniedByUa(uaResp?.summary ?? [], deniedUa),
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
  // Whatever was judged goes on the watch list, so "who was that?" outlives this run's stdout.
  const listed = await recordAdditions(
    process.cwd(),
    WATCHLIST_FILE,
    watchlistAdditions(findings),
    new Date(),
  );
  if (listed.error) errors.push(`watch list: ${listed.error}`);

  const report: WatchReport = {
    window,
    screened: rows.reduce((n, r) => n + r.allowed, 0),
    fingerprints: rows.length,
    candidates: findings.length,
    truncated,
    findings,
    // Cheap and unrelated to the screen: a deny rule that stopped denying reads as handled
    // while the traffic it lists is served normally.
    enforcement: await enforcementOrError(errors),
    // The other direction of the same question. A bypassed path exists because its caller
    // cannot answer a challenge, so one arriving there fails with nobody to see it.
    reachability: await reachabilityOrError(creds, window, errors),
    errors,
  };
  console.log(
    toAnsi(watchLines(report), {
      colour: useColour(),
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
      // Marked BEFORE the spawn so a crash mid-run cannot re-buy the same answer, and removed
      // again below if the run bought nothing: a failed investigation that consumed the 7-day
      // memory left the digest unexamined for a week having produced no verdict at all.
      seen.set(f.digest.toLowerCase(), now);
      // Taken either side of the spawn. The investigation is instructed not to apply anything
      // and cannot be prevented from it, so the honest position is to check rather than trust.
      const envPath = `${process.cwd()}/.env.local`;
      const before = await fingerprintConfig(envPath);
      const out = await runInvestigation(f, process.cwd(), hours);
      if (
        investigationChangedConfig(before, await fingerprintConfig(envPath))
      ) {
        const alarm = `.env.local CHANGED during the investigation of ${f.digest} — the run was told not to apply anything. Check FW_BLOCKED_JA4 and the live WAF.`;
        report.errors.push(alarm);
        await logWatch(process.cwd(), new Date(), {
          kind: 'error',
          error: alarm,
        });
      }
      const verdict = out.ok ? verdictFrom(out.verdict) : 'unclear';
      if (!out.ok) seen.delete(f.digest.toLowerCase());
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

  // What is worth a message: the investigation's conclusion AND anything else actionable.
  //
  // These used to be either/or, on the reasoning that asking for --investigate means you want
  // Claude's answer rather than the screen's. But the screen also carries alarms an
  // investigation says nothing about — a deny rule that stopped enforcing, a query that failed,
  // a truncated window where the tool was blind — and choosing the conclusion silently dropped
  // every one of them, on precisely the flag combination an unattended cron runs.
  if (argv.includes('--notify')) {
    const key = [concludedKey(concluded), actionableKey(report)]
      .filter(Boolean)
      .join('|');
    if (await shouldNotify(process.cwd(), key)) {
      const failed = await notify(
        [
          concluded.length ? concludedText(concluded) : '',
          isActionable(report) ? notifyText(report) : '',
        ]
          .filter(Boolean)
          .join(' · '),
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
/**
 * Enforcement issues, or the read failure recorded as an error.
 *
 * Unguarded, this sat inside the report literal: `rules.ts` evaluates required env at import, so
 * one missing ceiling threw, rejected `main()`, and discarded a screen that had already completed
 * — taking the notification with it, on the path where nobody reads stdout.
 */
/**
 * Exempted paths answering only mitigations, or the read failure recorded as an error.
 *
 * Its own try/catch for the same reason as the enforcement check beside it: a failed query must
 * not reject `main()` and discard a screen that already completed.
 */
async function reachabilityOrError(
  creds: Parameters<typeof makeCtx>[0],
  window: Window,
  errors: string[],
): Promise<string[]> {
  try {
    const { rules } = await import('./rules');
    const { ctx } = makeCtx(creds, window);
    // The agent dimension costs nothing here and is what separates a path nobody can reach
    // from a path one client cannot — the second is invisible to a served/mitigated ratio.
    const resp = await metrics(
      ctx,
      ['requestPath', 'clientUserAgent', 'wafAction'],
      { limit: GROUP_CAP },
    );
    const rows = (resp.summary ?? resp.data ?? []).map((r: Row) => ({
      path: String(r['requestPath'] ?? ''),
      agent: String(r['clientUserAgent'] ?? ''),
      action: String(r['wafAction'] ?? ''),
      count: countOf(r),
    }));
    const { findings, error } = reachabilityFindings(
      rows,
      bypassPaths(rules),
      // requestPath x agent x action is a wide grouping; at the cap the rows we need may
      // be the ones dropped, and a verdict from that is a guess wearing an alarm's clothes.
      { truncated: rows.length >= GROUP_CAP },
    );
    if (error) errors.push(error);
    return findings;
  } catch (e) {
    errors.push(`reachability check failed: ${errMsg(e)}`);
    return [];
  }
}

async function enforcementOrError(errors: string[]): Promise<string[]> {
  try {
    return await enforcementIssues();
  } catch (e) {
    errors.push(`enforcement check failed: ${errMsg(e)}`);
    return [];
  }
}

async function enforcementIssues(): Promise<string[]> {
  const { fetchLive } = await import('./client');
  const live = await fetchLive();
  // null, never 0, when the list cannot be parsed — see notEnforcing.
  const ENV_FOR: Record<string, string> = {
    'deny-scraper-ja4': 'FW_BLOCKED_JA4',
    'deny-scraper-asn': 'FW_BLOCKED_ASN',
    'deny-scraper-ua': 'FW_BLOCKED_UA',
    'challenge-scraper-ja4': 'FW_CHALLENGE_JA4',
  };
  const count = (name: string, spec: typeof JA4_DENY): number | null => {
    // null, not 0, when the rule has no env key: `envMatching('')` reads undefined and returns [],
    // which notEnforcing treats as the intended revoked state and skips silently — collapsing the
    // could-not-read/empty distinction that function exists to preserve, one layer above it.
    const key = ENV_FOR[name];
    if (!key) return null;
    try {
      return envMatching(key, spec, false).length;
    } catch {
      return null;
    }
  };
  // Deliberately no overlap check here. A digest on both lists is the NORMAL transient of the
  // documented promotion path, and everything downstream reads `enforcement` by length —
  // exitCodeFor, isActionable and notifyText — so reporting it would exit non-zero and put
  // "1 rule(s) not enforcing" on a phone for a config where every rule is doing its job.
  return notEnforcing(
    (
      [
        ['deny-scraper-ja4', JA4_DENY],
        ['deny-scraper-asn', ASN_DENY],
        // The name lever too. Without it a token could sit in FW_BLOCKED_UA un-applied, or be
        // cycled to `log` in the TUI, while `deniedByUa` treated the crawler as handled and
        // dropped it from candidacy — a crawler nothing was stopping and nothing was reporting.
        ['deny-scraper-ua', UA_DENY],
        ['challenge-scraper-ja4', JA4_DENY],
      ] as const
    ).map(([name, spec]) => ({
      name,
      active: live.activeByName.get(name) ?? false,
      action: live.actionByName.get(name) ?? 'log',
      values: count(name, spec),
      // The challenge tier is enforcing when it CHALLENGES. Defaulting to 'deny' would report a
      // correctly-working recoverable tier as blocking nothing.
      expected: isRecoverableRule(name) ? 'challenge' : 'deny',
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
