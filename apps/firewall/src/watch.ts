// Entrypoint for `bun run firewall:watch` — what is getting through that should not be.
// READ-ONLY. It never stages a deny and never applies; it prints a case and a human decides.
//
// It does NOT try to find scrapers from first principles. Measured 2026-08-05, Vercel's managed
// bot protection already challenges ~93% of `automated_browser` and all of `uncategorized_bot`
// and `client_anomaly`. The gap is `browser_impersonation`, where a large share is still
// allowed through — and that is the category a driven-browser scraper lands in. So the screen
// asks Vercel for its own classification and looks only at what it classified and then let
// past. Adjudicating those is the part Vercel cannot do: deciding a fingerprint is safe to DENY
// rather than merely challenge needs to know what a real session on this site looks like.

import { type Advice, adviseBan } from './ban-advice';
import { resolveVercelCredentials } from './credentials';
import { ASN_DENY, JA4_DENY, envMatching } from './deny-list';
import { fetchIpProfile } from './ip-profile';
import { type Line, blank, line, seg, toAnsi } from './line-model';
import { makeCtx, metrics, top } from './observability';
import { type Window, rollingWindow } from './time-window';
import { errMsg } from './util';

const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 6; // the free observability window
// Below this a digest cannot clear the advisory's own volume floor anyway, so profiling it
// (~21 queries) buys nothing but API budget.
const SCREEN_FLOOR = 100;
// A profile is expensive; a screen that suddenly matches everything means the category changed,
// not that the site is under attack from fifty actors at once.
const MAX_PROFILES = 6;

const USAGE = `Usage:
  bun run firewall:watch [hours]     default ${DEFAULT_HOURS}h, max ${MAX_HOURS}h

Read-only. Exits 1 when something wants a human, 0 when quiet.`;

export type Screened = { digest: string; allowed: number };

/** One adjudicated candidate: what the screen saw, and what the advisory made of it. */
export type Finding = Screened & { total: number; advice: Advice };

export type WatchReport = {
  window: Window;
  /** Requests Vercel classified browser_impersonation and then allowed. */
  screened: number;
  fingerprints: number;
  candidates: number;
  findings: Finding[];
  enforcement: string[];
  errors: string[];
};

/** True when a human should look. Kept separate from rendering so the exit code and the text cannot disagree. */
export function isActionable(r: WatchReport): boolean {
  return (
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
  L.push(
    blank(),
    line(
      `${r.screened} request(s) classified browser_impersonation and ALLOWED, across ${r.fingerprints} fingerprint(s)`,
    ),
    line(
      seg(
        `  ${r.candidates} above the ${SCREEN_FLOOR}-request floor and not already denied`,
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
  rows: [string, number][],
  denied: string[],
  floor = SCREEN_FLOOR,
  cap = MAX_PROFILES,
): Screened[] {
  const already = new Set(denied.map((d) => JA4_DENY.normalize(d)));
  return rows
    .filter(([digest, allowed]) => {
      if (!digest || digest === '(none)') return false;
      if (allowed < floor) return false;
      return !already.has(JA4_DENY.normalize(digest));
    })
    .slice(0, cap)
    .map(([digest, allowed]) => ({ digest, allowed }));
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

/** The digests Vercel classified as impersonating a browser and then allowed through. */
async function screen(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
): Promise<[string, number][]> {
  const { ctx } = makeCtx(creds, window);
  return top(
    await metrics(ctx, ['clientJa4Digest'], {
      // Vercel's own classification, so the screen inherits its bot detection rather than
      // re-deriving one. `allow` is the point: challenged traffic is already being handled.
      filter: "botCategory eq 'browser_impersonation' and wafAction eq 'allow'",
      limit: 500,
    }),
    'clientJa4Digest',
    50,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const raw = argv.find((a) => !a.startsWith('--'));
  const hours = raw === undefined ? DEFAULT_HOURS : Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
    throw new Error(`hours must be an integer from 1 to ${MAX_HOURS}`);

  const creds = resolveVercelCredentials();
  const window = rollingWindow(hours, new Date());
  const errors: string[] = [];

  // Not required: an unreadable denylist means nothing is known to be already-denied, which
  // only ever makes the screen wider.
  let deniedJa4: string[] = [];
  try {
    deniedJa4 = envMatching('FW_BLOCKED_JA4', JA4_DENY, false);
  } catch (e) {
    errors.push(`FW_BLOCKED_JA4 unreadable: ${errMsg(e)}`);
  }

  const rows = await screen(creds, window);
  const candidates = worthProfiling(rows, deniedJa4);
  const findings: Finding[] = [];
  for (const c of candidates) {
    const p = await fetchIpProfile(
      creds,
      { kind: 'ja4', value: c.digest },
      window,
    );
    findings.push({
      ...c,
      total: p.total,
      advice: adviseBan({
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
        mixPartial: p.mixPartial,
      }),
    });
  }

  const report: WatchReport = {
    window,
    screened: rows.reduce((n, [, c]) => n + c, 0),
    fingerprints: rows.length,
    candidates: candidates.length,
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
  process.exitCode = isActionable(report) ? 1 : 0;
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
    process.exit(1);
  });
