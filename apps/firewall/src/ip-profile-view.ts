// Renders an IpProfile as plain text. Kept apart from the fetching so the layout can be tested
// without network, and so output stays pipeable (no Ink, no cursor control).

import type { IpProfile } from './ip-profile';
import type { Shape, Tell } from './ip-signals';

const BAR_WIDTH = 40;
const MAX_BUCKETS = 60; // busiest rendered as bars; beyond this the chart stops being readable
const TOP_ROWS = 12;

type Ink = ReturnType<typeof colour>;

function colour(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `[${code}m${s}[0m` : s);
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    green: wrap('32'),
    red: wrap('31'),
  };
}

/** `2026-08-03T20:00:00.000Z` → `08-03 20:00Z`, the only part of a bucket stamp worth reading. */
function stamp(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
}

/** Count-first rows, truncated with a tail summary so a long list never hides its own size. */
function table(rows: [string, number][], limit: number, c: Ink): string[] {
  const out = rows
    .slice(0, limit)
    .map(([k, n]) => `  ${String(n).padStart(7)}  ${k}`);
  if (rows.length > limit) {
    const rest = rows.slice(limit).reduce((s, [, n]) => s + n, 0);
    out.push(c.dim(`  ${' '.repeat(7)}  … +${rows.length - limit} more (${rest} req)`));
  }
  return out;
}

function labelled(label: string, rows: [string, number][], limit: number, c: Ink): string[] {
  if (!rows.length) return [];
  return rows.slice(0, limit).map(([k, n], i) => {
    const head = i === 0 ? label.padEnd(9) : ' '.repeat(9);
    return `  ${c.dim(head)}${String(n).padStart(6)}  ${k}`;
  });
}

function sessionLines(shape: Shape, c: Ink): string[] {
  if (!shape.sessions.length) return ['  (no traffic in the window)'];
  const unit = `${shape.bucketMinutes}min`;
  const out = [
    `  ${shape.sessions.length} session${shape.sessions.length === 1 ? '' : 's'} · ` +
      `${(shape.concentration * 100).toFixed(0)}% of requests in the busiest · ` +
      `peak ${shape.peak}/${unit} · median ${shape.median} · longest run ${shape.longestRun}`,
    '',
  ];
  for (const s of shape.sessions) {
    out.push(
      `  ${c.bold(`${stamp(s.start)} → ${stamp(s.end)}`)}   ` +
        `${s.buckets * shape.bucketMinutes} min, ${s.total} req`,
    );
  }
  return out;
}

/** Bars for the active buckets only — a 24h window is mostly zeros, and printing them buries the session. */
function bucketChart(
  buckets: { t: string; c: number }[],
  peak: number,
  c: Ink,
): string[] {
  const active = buckets.filter((b) => b.c > 0);
  if (!active.length) return [];
  const scale = Math.max(1, peak);
  const shown = active.slice(0, MAX_BUCKETS);
  const out = shown.map(
    (b) =>
      `  ${c.dim(stamp(b.t))}  ${String(b.c).padStart(5)}  ` +
      '█'.repeat(Math.max(1, Math.round((b.c / scale) * BAR_WIDTH))),
  );
  if (active.length > shown.length)
    out.push(c.dim(`  … +${active.length - shown.length} more active buckets`));
  return out;
}

function tellLines(tells: Tell[], c: Ink): string[] {
  const tag = (t: Tell) =>
    t.points === 'human'
      ? c.green('browser  ')
      : t.points === 'bot'
        ? c.red('automated')
        : c.dim('note     ');
  return tells.map((t) => `  ${tag(t)}  ${t.label.padEnd(17)} ${c.dim(t.detail)}`);
}

/** Full plain-text profile. `useColour` off when piped, so redirected output stays clean. */
export function renderProfile(p: IpProfile, useColour: boolean): string {
  const c = colour(useColour);
  const L: string[] = [];
  const head = (s: string) => L.push('', c.bold(s));

  L.push(
    c.bold(`${p.ip} — last ${p.windowHours}h`) +
      c.dim(`  (${p.start.slice(0, 16)}Z → ${p.end.slice(0, 16)}Z)`),
  );
  L.push(`${p.total} requests`);

  head('SIGNALS');
  L.push(...tellLines(p.tells, c));

  head(`SESSION SHAPE (${p.shape.bucketMinutes}-min buckets)`);
  L.push(...sessionLines(p.shape, c));
  const chart = bucketChart(p.buckets, p.shape.peak, c);
  if (chart.length) L.push('', ...chart);

  head('IDENTITY');
  L.push(...labelled('JA4', p.byJa4, 4, c));
  L.push(...labelled('UA', p.byUserAgent, 5, c));
  L.push(...labelled('ASN', p.byAsn, 4, c));
  L.push(...labelled('country', p.byCountry, 4, c));
  L.push(...labelled('bot', p.byBot.filter(([k]) => k && k !== '(none)'), 4, c));
  L.push(...labelled('verified', p.byBotVerified, 4, c));

  head('TRAFFIC MIX');
  const m = p.mix;
  L.push(
    `  page ${m.page} · rpc ${m.rpc} · asset ${m.asset} · beacon ${m.beacon} · tile ${m.tile} · crawl ${m.crawl}`,
  );

  head('FIREWALL');
  L.push(...labelled('action', p.byWafAction, 6, c));
  // Managed rulesets carry no custom rule id, so the unnamed bucket is noise here.
  const rules = p.byWafRule.filter(([k]) => k !== '(none)');
  L.push(...labelled('rule', rules, 6, c));

  head('STATUS');
  L.push(...table(p.byStatus, 8, c));

  head('TOP PATHS');
  L.push(...table(p.byPath, TOP_ROWS, c));

  const refs = p.byReferrer.filter(([k]) => k !== '(none)');
  if (refs.length) {
    head('REFERRERS');
    L.push(...table(refs, 8, c));
  }

  if (p.errors.length) {
    head('INCOMPLETE');
    L.push(...p.errors.map((e) => `  ${e}`));
  }

  return L.join('\n');
}
