// Lays out an IpProfile as lines. Free of both ANSI and Ink, so the CLI and the TUI pane render
// the same layout through their own backends.

import type { Advice } from './ban-advice';
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

/** `2026-08-03T20:00:00.000Z` → `08-03 20:00Z`, the only part of a bucket stamp worth reading. */
function stamp(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

function heading(text: string): Line[] {
  return [blank(), line(seg(text, 'bold'))];
}

function sessionLines(shape: Shape): Line[] {
  if (!shape.sessions.length) return [line(seg('  (no traffic in the window)', 'dim'))];
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
      line(seg(`  … +${active.length - shown.length} more active buckets`, 'dim')),
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

function reachLine(
  what: string,
  r: IpProfile['digestReach'],
  hours: number,
): Line[] {
  if (!r) return [];
  return [
    line(
      seg(
        `  ${what} (${hours}h): ${r.ips} IPs · ${r.countries} countries · ${r.total} req · ` +
          `${r.subResources + r.beacons} sub-resources` +
          (r.verifiedNames.length
            ? ` · verified: ${r.verifiedNames.join(', ')}`
            : ''),
        'dim',
      ),
    ),
  ];
}

/** The recommendation block. Blockers and rejected levers print even on a `ban`-less verdict — knowing WHY something is untouchable is the useful part. */
function adviceLines(a: Advice, p: IpProfile): Line[] {
  const tone =
    a.verdict === 'ban'
      ? 'bad'
      : a.verdict === 'watch' || a.verdict === 'staged'
        ? 'warn'
        : a.verdict === 'already'
          ? 'dim'
          : 'good';
  const headline =
    a.verdict === 'ban'
      ? `DENY RECOMMENDED (${a.lever?.kind.toUpperCase()}) — press b to stage, a to apply`
      : a.verdict === 'staged'
        ? 'STAGED — not live yet; press a to apply, or u in the denylist to drop it'
        : a.verdict === 'watch'
          ? 'INCONCLUSIVE — no safe lever, do not deny'
          : a.verdict === 'already'
            ? 'ALREADY DENIED — the evidence stands, the rule is in place'
            : 'DO NOT DENY';
  const L: Line[] = [blank(), line(seg('RECOMMENDATION', 'bold'))];
  L.push(line('  ', seg(headline, tone)));
  if (a.lever)
    L.push(
      line(
        seg('  target  ', 'dim'),
        seg(a.lever.value, 'key'),
        seg(
          a.lever.kind === 'ja4'
            ? '  (FW_BLOCKED_JA4)'
            : '  (FW_BLOCKED_ASN — needs the AS number)',
          'dim',
        ),
      ),
    );
  L.push(...reachLine('fingerprint', p.digestReach, p.reachHours));
  L.push(...reachLine('network', p.asnReach, p.reachHours));
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

  L.push(
    line(
      seg(`${p.ip} — ${p.windowLabel}`, 'bold'),
      seg(`  (${p.start.slice(0, 16)}Z → ${p.end.slice(0, 16)}Z)`, 'dim'),
    ),
    line(`${p.total} requests`),
  );

  L.push(...heading('SIGNALS'), ...tellLines(p.tells));
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
  L.push(
    ...heading('TRAFFIC MIX'),
    line(
      `  page ${m.page} · rpc ${m.rpc} · api ${m.api} · asset ${m.asset} · beacon ${m.beacon} · tile ${m.tile} · crawl ${m.crawl}`,
    ),
  );

  L.push(...heading('FIREWALL'));
  L.push(...labelledRows('action', p.byWafAction, 6));
  // Managed rulesets carry no custom rule id, so the unnamed bucket is noise here.
  L.push(...labelledRows('rule', p.byWafRule.filter(([k]) => k !== '(none)'), 6));

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
