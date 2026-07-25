// Pure formatters for the report pane — numbers and state in, strings and colour names out.
// Deliberately free of JSX and Ink so the calibration-critical bits (what a bar means, when a
// row turns red, how an unresolved peak is written) can be reasoned about and tested without
// rendering anything.

import type { DistRow, Distribution } from './report-data';

const BAR_W = 10;

/** A bar whose fill is `value` relative to `peak` (the busiest IP in the list), so the heaviest IP reads as full and lighter IPs scale down — making the distribution visible even when everyone is far under the limit. */
export function usageBar(value: number, peak: number): string {
  const filled =
    peak > 0
      ? Math.max(0, Math.min(BAR_W, Math.round((value / peak) * BAR_W)))
      : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_W - filled)}]`;
}

/** Bar colour by proximity to whichever ceiling the IP is nearest — burst OR sustained: green safe · yellow watch · red near/over; neutral cyan when neither is configured. Colouring on burst alone would paint a flat scraper green while it sits at 180% of the sustained ceiling, which is the one client the sustained rule exists to catch. */
export function barColor(
  r: DistRow,
  limit?: number,
  sustainedLimit?: number,
): string {
  // An unmeasured row's peaks are 0 only because nothing was measured; green would be a
  // safety claim about a row we know nothing about. Neutral, matching its dashed columns.
  if (!r.sampled || (!limit && !sustainedLimit)) return 'cyan';
  const ratio = Math.max(
    limit ? r.peakMin / limit : 0,
    sustainedLimit ? r.peak10m / sustainedLimit : 0,
  );
  return ratio >= 0.8 ? 'red' : ratio >= 0.5 ? 'yellow' : 'green';
}

/** Compact request count: 1234 → `1.2k`. Keeps the whole-window volume column narrow. */
function compact(n: number): string {
  return n >= 10000
    ? `${Math.round(n / 1000)}k`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);
}

/** Configured ceilings and IP count: `limit 300/min · sust 1000/10m · 178 IPs`. */
export function distHeader(d: Distribution): string {
  const ips = `${d.ips}${d.capped ? '+' : ''} IP${d.ips === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (d.limit) parts.push(`limit ${d.limit}/min`);
  if (d.sustainedLimit) parts.push(`sust ${d.sustainedLimit}/10m`);
  parts.push(ips);
  return parts.join(' · ');
}

/** Measured worst case against those ceilings, plus what the claim actually covers: `exact`/`floor` applies only to the top-N IPs by volume that were measured, never to every IP on the path, and an unmeasured low-volume client could always have burst higher. */
export function distPeaks(d: Distribution): string {
  const pct = (v: number, lim?: number) =>
    lim ? ` (${((v / lim) * 100).toFixed(0)}%)` : '';
  const min = `${d.maxPeakMin ?? 0}/min${pct(d.maxPeakMin ?? 0, d.limit)}`;
  const ten = `${d.maxPeak10m ?? 0}/10m${pct(d.maxPeak10m ?? 0, d.sustainedLimit)}`;
  const n = d.sampledWindows ?? 0;
  const how = d.exact ? 'exact' : 'floor'; // floor = the round cap stopped the search early
  return `peak ${min} · ${ten} · ${how} over top ${d.measuredIps ?? 0} IPs, ${n} window${n === 1 ? '' : 's'} zoomed`;
}

/** One IP's line: `  99/min   227/10m   917  1.2.3.4`. Unresolved bursts are never printed as a bare number: `108+` means at least that much was observed, `<=63` means it was never opened up but provably cannot exceed that (refining it would not have changed the leader), and an unmeasured IP dashes BOTH peak columns — a bare `0/10m` reads as a measurement. The trailing total is whole-window volume, the signal that exposes slow wide enumeration whose per-minute and per-10-minute figures both look ordinary. */
export function distRowText(r: DistRow): string {
  const tail = `${compact(r.total).padStart(6)}  ${r.ip}`;
  if (!r.sampled)
    return `${'—'.padStart(6)}/min ${'—'.padStart(5)}/10m ${tail}`;
  const min = r.peakMinExact
    ? String(r.peakMin)
    : r.peakMin > 0
      ? `${r.peakMin}+`
      : `<=${r.peakMinBound}`;
  return `${min.padStart(6)}/min ${String(r.peak10m).padStart(5)}/10m ${tail}`;
}
