// Lays out an IpProfile as lines. Free of both ANSI and Ink, so the CLI and the TUI pane render
// the same layout through their own backends.

import type { Advice, Lever } from './ban-advice';
import type { IpProfile } from './ip-profile';
import type { Shape, Tell } from './ip-signals';
import {
  type Line,
  blank,
  countRows,
  labelledRows,
  line,
  seg,
} from './line-model';
import { mismatchLines } from './ua-fingerprint';

const BAR_GUTTER = 26; // stamp + count columns before a bar starts
const BAR_MIN = 20;
const BAR_MAX = 90; // past this the eye stops comparing lengths usefully
const MAX_BUCKETS = 60; // beyond this the chart stops being readable
const TOP_ROWS = 12;

/** Bar length for the column width available, so a wide pane is actually used. */
export function barWidth(paneWidth: number | undefined): number {
  if (!paneWidth) return BAR_MIN + 14;
  return Math.max(BAR_MIN, Math.min(BAR_MAX, paneWidth - BAR_GUTTER));
}

/** How stale a snapshot is. A tab keeps its data until refreshed, so a "live" label alone would imply a currency it does not have. */
export function ageLabel(fetchedAt: string, now: number): string {
  const secs = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${mins % 60 ? ` ${mins % 60}m` : ''} ago`;
}

/** `2026-08-03T20:00:00.000Z` → `08-03 20:00Z`, the only part of a bucket stamp worth reading. */
function stamp(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

function heading(text: string): Line[] {
  return [blank(), line(seg(text, 'bold'))];
}

function sessionLines(shape: Shape): Line[] {
  if (!shape.sessions.length)
    return [line(seg('  (no traffic in the window)', 'dim'))];
  const unit = `${shape.bucketMinutes}min`;
  const out: Line[] = [
    line(
      `  ${shape.sessions.length} session${shape.sessions.length === 1 ? '' : 's'} · ` +
        `${(shape.concentration * 100).toFixed(0)}% in the busiest · ` +
        `peak ${shape.peak}/${unit} · median ${shape.median} · longest run ${shape.longestRun}`,
    ),
    blank(),
  ];
  for (const s of shape.sessions) {
    out.push(
      line(
        seg(`  ${stamp(s.start)} → ${stamp(s.end)}`, 'bold'),
        seg(`   ${s.buckets * shape.bucketMinutes} min, ${s.total} req`),
      ),
    );
  }
  return out;
}

/** Bars for the active buckets only — a 24h window is mostly zeros, and printing them buries the session. */
function bucketChart(
  buckets: { t: string; c: number }[],
  peak: number,
  bar: number,
): Line[] {
  const active = buckets.filter((b) => b.c > 0);
  if (!active.length) return [];
  const scale = Math.max(1, peak);
  const shown = active.slice(0, MAX_BUCKETS);
  const out = shown.map((b) =>
    line(
      seg(`  ${stamp(b.t)}  `, 'dim'),
      `${String(b.c).padStart(5)}  `,
      seg('█'.repeat(Math.max(1, Math.round((b.c / scale) * bar))), 'key'),
    ),
  );
  if (active.length > shown.length)
    out.push(
      line(
        seg(`  … +${active.length - shown.length} more active buckets`, 'dim'),
      ),
    );
  return out;
}

function tellLines(tells: Tell[]): Line[] {
  return tells.map((t) =>
    line(
      '  ',
      t.points === 'human'
        ? seg('browser  ', 'good')
        : t.points === 'bot'
          ? seg('automated', 'bad')
          : seg('note     ', 'dim'),
      `  ${t.label.padEnd(17)} `,
      seg(t.detail, 'dim'),
    ),
  );
}

/**
 * The impersonation check, in the SIGNALS block beside the other evidence.
 *
 * Three distinct states, rendered distinctly. Undecidable is `note`, not `browser` — a check that
 * could not run is not a check that passed, and the two have been collapsed here before.
 */
function impersonationLines(p: IpProfile): Line[] {
  const v = p.uaCheck;
  const tag =
    v.mismatched === null
      ? seg('note     ', 'dim')
      : v.mismatched.length
        ? seg('automated', 'bad')
        : seg('browser  ', 'good');
  const L: Line[] = [
    line('  ', tag, `  ${'ua vs TLS'.padEnd(17)} `, seg(v.note, 'dim')),
  ];
  for (const detail of mismatchLines(v))
    L.push(
      line(
        '  ',
        seg('         ', 'dim'),
        `  ${''.padEnd(17)} `,
        seg(detail, 'dim'),
      ),
    );
  return L;
}

function reachLine(
  what: string,
  r: IpProfile['digestReach'],
  hours: number,
): Line[] {
  if (!r) return [];
  // `complete` is the flag that stops absent evidence reading as a measured zero, and this is
  // the block an operator reads to decide a blanket deny — so it has to appear here, not only
  // in the advisory's reasoning.
  const ge = r.complete ? '' : '≥';
  return [
    line(
      seg(
        `  ${what} (${hours}h): ${r.ips} IPs · ${r.countries} countries · ${ge}${r.total} req · ` +
          `${ge}${r.subResources + r.beacons + r.tiles + r.rpcs} rendering requests` +
          (r.verifiedNames.length
            ? ` · verified: ${r.verifiedNames.join(', ')}`
            : ''),
        r.complete ? 'dim' : 'warn',
      ),
    ),
    ...(r.complete
      ? []
      : [
          line(
            seg(
              '    sample incomplete — a query failed or the tail was truncated, so these are floors',
              'warn',
            ),
          ),
        ]),
  ];
}

/** The `.env.local` list a lever's value belongs on. Both tiers key on a JA4, so the TIER decides, not the kind. */
export function envVarFor(lever: Lever): string {
  if (lever.kind === 'asn') return 'FW_BLOCKED_ASN — needs the AS number';
  return lever.tier === 'challenge' ? 'FW_CHALLENGE_JA4' : 'FW_BLOCKED_JA4';
}

/**
 * What the operator is overriding when they deny something the advisory did not recommend.
 *
 * The advisory ADVISES. It used to hold the keys as well — `b` did nothing at all unless a `ban`
 * verdict had attached a lever — which is the wrong place for that authority: a human looking at
 * the evidence can see things the axes cannot, and a keypress that silently does nothing reads
 * as a broken tool rather than as a refusal. So the veto became a warning, and this is its text.
 *
 * Ordered by what actually decides the case: a legitimacy blocker is a statement about the
 * client, and outranks a lever note, which is only a statement about the handle.
 */
export function overrideWarning(a: Advice): string {
  const objection =
    a.blockers[0] ??
    a.leverNotes[0] ??
    'the advisory found nothing either way on this identity';
  return `The advisory did NOT recommend this (verdict: ${a.verdict}). Its objection: ${objection}`;
}

/**
 * The clarification shown when staging a deny from an IP profile.
 *
 * There is NO IP lever in this tool: `Condition['type']` offers path, query, header, user_agent,
 * ja4_digest and geo_as_number, and nothing else, so the deny rules cannot key on an address.
 * Pressing `b` on an IP profile therefore stages that IP's DOMINANT FINGERPRINT, which is a far
 * wider thing than the address on screen — on a Chrome-family digest, wider than the whole site's
 * traffic. That has to be said in the confirmation rather than assumed to be understood, because
 * the two look identical once the dialog is open.
 */
export function fingerprintScopeNote(
  subject: { kind: 'ip' | 'ja4'; value: string },
  digest: string,
): string {
  return subject.kind === 'ip'
    ? `NOTE: this denies FINGERPRINT ${digest}, NOT the IP ${subject.value} — there is no IP lever. Every client sharing that TLS build is denied.`
    : '';
}

/** The recommendation block. Blockers and rejected levers print even on a `ban`-less verdict — knowing WHY something is untouchable is the useful part. */
function adviceLines(a: Advice, p: IpProfile): Line[] {
  const tone =
    a.verdict === 'ban'
      ? 'bad'
      : a.verdict === 'challenge' ||
          a.verdict === 'watch' ||
          a.verdict === 'staged'
        ? 'warn'
        : a.verdict === 'already'
          ? 'dim'
          : 'good';
  const headline =
    a.verdict === 'ban'
      ? `DENY RECOMMENDED (${a.lever?.kind.toUpperCase()}) — press b to stage, a to apply`
      : a.verdict === 'challenge'
        ? 'CHALLENGE RECOMMENDED — the fingerprint is SHARED, so deny would hit real browsers'
        : a.verdict === 'staged'
          ? 'STAGED — not live yet; press a to apply, or u in the denylist to drop it'
          : a.verdict === 'watch'
            ? // "Inconclusive" is about the EVIDENCE. If a challenge is live it is a fact about
              // the WAF, and printing only the first tells an operator nothing is in place while
              // every request on this fingerprint is being interstitialed.
              a.challengeLive
              ? 'INCONCLUSIVE on new evidence — but a CHALLENGE IS LIVE on this fingerprint (FW_CHALLENGE_JA4)'
              : 'INCONCLUSIVE — no safe lever, do not deny'
            : a.verdict === 'already'
              ? // Which tier is live is not a detail: "denied" and "challenged" lead to different
                // next actions, and saying DENIED about an interstitial is the more costly way
                // round — it reads as handled when the traffic is still being served.
                a.lever?.tier === 'challenge'
                ? 'ALREADY CHALLENGED — live on FW_CHALLENGE_JA4; press b to promote it to a deny'
                : 'ALREADY DENIED — the evidence stands, the rule is in place'
              : 'DO NOT DENY';
  const L: Line[] = [blank(), line(seg('RECOMMENDATION', 'bold'))];
  L.push(line('  ', seg(headline, tone)));
  if (a.lever)
    L.push(
      line(
        seg('  target  ', 'dim'),
        seg(a.lever.value, 'key'),
        // Read off the lever's own tier, never inferred from `kind`: both tiers key on a JA4, so
        // a kind-only label names FW_BLOCKED_JA4 for a challenge and tells the operator the
        // recommendation is a deny.
        seg(`  (${envVarFor(a.lever)})`, 'dim'),
      ),
    );
  L.push(...reachLine('fingerprint', p.digestReach, p.reachHours));
  L.push(...reachLine('network', p.asnReach, p.reachHours));
  // Deliberately NOT folded into `blockers`, which render green and read as reassurance. A live
  // mitigation is a warning: it is costing somebody something right now, and the operator has to
  // weigh that whatever the evidence says.
  if (a.challengeLive && a.verdict !== 'already')
    L.push(
      line(
        '  ',
        seg('LIVE      ', 'warn'),
        seg(
          'this fingerprint is on FW_CHALLENGE_JA4 — every request to it is being challenged now',
          'dim',
        ),
      ),
    );
  for (const b of a.blockers)
    L.push(line('  ', seg('blocker  ', 'good'), seg(b, 'dim')));
  for (const n of a.leverNotes)
    L.push(line('  ', seg('lever    ', 'warn'), seg(n, 'dim')));
  for (const r of a.reasons)
    L.push(line('  ', seg('evidence ', 'dim'), seg(r, 'dim')));
  return L;
}

/** Full profile layout. `paneWidth` only scales the bar chart; everything else is clipped by the renderer. */
export function profileLines(
  p: IpProfile,
  paneWidth?: number,
  advice?: Advice,
): Line[] {
  const L: Line[] = [];

  const age = ageLabel(p.fetchedAt, Date.now());
  L.push(
    line(
      seg(`${p.ip} — ${p.windowLabel}`, 'bold'),
      seg(`  (${p.start.slice(0, 16)}Z → ${p.end.slice(0, 16)}Z)`, 'dim'),
      // Never let a "live" window imply the numbers below it are current.
      seg(`  fetched ${age}`, age === 'just now' ? 'dim' : 'warn'),
    ),
    line(`${p.total} requests`),
  );

  L.push(
    ...heading('SIGNALS'),
    ...tellLines(p.tells),
    ...impersonationLines(p),
  );
  if (advice) L.push(...adviceLines(advice, p));

  L.push(...heading(`SESSION SHAPE (${p.shape.bucketMinutes}-min buckets)`));
  L.push(...sessionLines(p.shape));
  const chart = bucketChart(p.buckets, p.shape.peak, barWidth(paneWidth));
  if (chart.length) L.push(blank(), ...chart);

  L.push(...heading('IDENTITY'));
  L.push(...labelledRows('JA4', p.byJa4, 4));
  L.push(...labelledRows('UA', p.byUserAgent, 5));
  L.push(...labelledRows('ASN', p.byAsn, 4));
  L.push(...labelledRows('country', p.byCountry, 4));
  L.push(
    ...labelledRows(
      'bot',
      p.byBot.filter(([k]) => k && k !== '(none)'),
      4,
    ),
  );
  L.push(...labelledRows('verified', p.byBotVerified, 4));

  const m = p.mix;
  const ge = p.mixPartial ? '≥' : '';
  L.push(
    ...heading('TRAFFIC MIX'),
    line(
      `  page ${ge}${m.page} · rpc ${ge}${m.rpc} · api ${ge}${m.api} · asset ${ge}${m.asset} · beacon ${ge}${m.beacon} · tile ${ge}${m.tile} · crawl ${ge}${m.crawl}`,
    ),
  );
  // A zero here is the evidence that BLOCKS a deny, so a truncated sample must never present
  // one as measured.
  if (p.mixPartial)
    L.push(
      line(
        seg(
          '  path sample truncated by the API — every count above is a floor, and a zero may be a dropped tail',
          'warn',
        ),
      ),
    );

  L.push(...heading('FIREWALL'));
  L.push(...labelledRows('action', p.byWafAction, 6));
  // Managed rulesets carry no custom rule id, so the unnamed bucket is noise here.
  L.push(
    ...labelledRows(
      'rule',
      p.byWafRule.filter(([k]) => k !== '(none)'),
      6,
    ),
  );

  L.push(...heading('STATUS'), ...countRows(p.byStatus, 8));
  L.push(...heading('TOP PATHS'), ...countRows(p.byPath, TOP_ROWS));

  const refs = p.byReferrer.filter(([k]) => k !== '(none)');
  if (refs.length) L.push(...heading('REFERRERS'), ...countRows(refs, 8));

  if (p.errors.length)
    L.push(
      ...heading('INCOMPLETE'),
      ...p.errors.map((e) => line(seg(`  ${e}`, 'warn'))),
    );

  return L;
}
