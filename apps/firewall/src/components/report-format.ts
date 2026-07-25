// Pure formatters for the report pane — numbers in, strings and colour names out.
// Free of JSX/Ink so the calibration rules are testable without rendering.

import type { DistRow, Distribution } from '../report-data';

const BAR_W = 10;

/** A bar filled relative to the busiest IP, so the spread stays visible even when all are far under the limit. */
export function usageBar(value: number, peak: number): string {
  const filled =
    peak > 0
      ? Math.max(0, Math.min(BAR_W, Math.round((value / peak) * BAR_W)))
      : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_W - filled)}]`;
}

/** Colour by proximity to the NEAREST ceiling, burst or sustained: green safe, yellow watch, red near/over, cyan unknown. */
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

/** Measured worst case, and what the claim covers — `exact`/`floor` applies only to the measured top-N IPs. */
export function distPeaks(d: Distribution): string {
  const pct = (v: number, lim?: number) =>
    lim ? ` (${((v / lim) * 100).toFixed(0)}%)` : '';
  const min = `${d.maxPeakMin ?? 0}/min${pct(d.maxPeakMin ?? 0, d.limit)}`;
  const ten = `${d.maxPeak10m ?? 0}/10m${pct(d.maxPeak10m ?? 0, d.sustainedLimit)}`;
  const n = d.sampledWindows ?? 0;
  const how = d.exact ? 'exact' : 'floor'; // floor = the round cap stopped the search early
  return `peak ${min} · ${ten} · ${how} over top ${d.measuredIps ?? 0} IPs, ${n} window${n === 1 ? '' : 's'} zoomed`;
}

/** One IP's line: `99/min 227/10m 917 1.2.3.4`. `108+` = at least; `<=63` = unresolved upper bound; `—` = unmeasured. */
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
