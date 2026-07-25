// Presentational components for the report pane — the right-hand side opened with 'r':
// actions-by-rule, top paths, and the per-IP peak distributions used to calibrate the
// FW_*_LIMIT ceilings. Pure (props in, no state/effects); the data comes from report-data.ts.

import { Box, Text } from 'ink';

import type { DistRow, ReportData } from './report-data';

type Distribution = ReportData['distributions'][number];

const BAR_W = 10;

/** A bar whose fill is `value` relative to `peak` (the busiest IP in the list), so the heaviest IP reads as full and lighter IPs scale down — making the distribution visible even when everyone is far under the limit. */
function usageBar(value: number, peak: number): string {
  const filled =
    peak > 0
      ? Math.max(0, Math.min(BAR_W, Math.round((value / peak) * BAR_W)))
      : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_W - filled)}]`;
}

/** Bar colour by proximity to whichever ceiling the IP is nearest — burst OR sustained: green safe · yellow watch · red near/over; neutral cyan when neither is configured. Colouring on burst alone would paint a flat scraper green while it sits at 180% of the sustained ceiling, which is the one client the sustained rule exists to catch. */
function barColor(r: DistRow, limit?: number, sustainedLimit?: number): string {
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
function distHeader(d: Distribution): string {
  const ips = `${d.ips}${d.capped ? '+' : ''} IP${d.ips === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (d.limit) parts.push(`limit ${d.limit}/min`);
  if (d.sustainedLimit) parts.push(`sust ${d.sustainedLimit}/10m`);
  parts.push(ips);
  return parts.join(' · ');
}

/** Measured worst case against those ceilings, plus what the claim actually covers: `exact`/`floor` applies only to the top-N IPs by volume that were measured, never to every IP on the path, and an unmeasured low-volume client could always have burst higher. */
function distPeaks(d: Distribution): string {
  const pct = (v: number, lim?: number) =>
    lim ? ` (${((v / lim) * 100).toFixed(0)}%)` : '';
  const min = `${d.maxPeakMin ?? 0}/min${pct(d.maxPeakMin ?? 0, d.limit)}`;
  const ten = `${d.maxPeak10m ?? 0}/10m${pct(d.maxPeak10m ?? 0, d.sustainedLimit)}`;
  const n = d.sampledWindows ?? 0;
  const how = d.exact ? 'exact' : 'floor'; // floor = the round cap stopped the search early
  return `peak ${min} · ${ten} · ${how} over top ${d.measuredIps ?? 0} IPs, ${n} window${n === 1 ? '' : 's'} zoomed`;
}

/** One IP's line: `  99/min   227/10m   917  1.2.3.4`. Unresolved bursts are never printed as a bare number: `108+` means at least that much was observed, `<=63` means it was never opened up but provably cannot exceed that (refining it would not have changed the leader), and an unmeasured IP dashes BOTH peak columns — a bare `0/10m` reads as a measurement. The trailing total is whole-window volume, the signal that exposes slow wide enumeration whose per-minute and per-10-minute figures both look ordinary. */
function distRowText(r: DistRow): string {
  if (!r.sampled)
    return `${'—'.padStart(6)}/min ${'—'.padStart(5)}/10m ${compact(r.total).padStart(6)}  ${r.ip}`;
  const min = r.peakMinExact
    ? String(r.peakMin)
    : r.peakMin > 0
      ? `${r.peakMin}+`
      : `<=${r.peakMinBound}`;
  return `${min.padStart(6)}/min ${String(r.peak10m).padStart(5)}/10m ${compact(r.total).padStart(6)}  ${r.ip}`;
}

/** One IP's line in a distribution: the usage bar, coloured by proximity to whichever ceiling that IP is nearest, followed by its measured figures. */
function DistLine({ row, dist }: { row: DistRow; dist: Distribution }) {
  return (
    <Box>
      <Text color={barColor(row, dist.limit, dist.sustainedLimit)}>
        {`${usageBar(row.peakMin, dist.maxPeakMin ?? 0)} `}
      </Text>
      <Text wrap="truncate">{distRowText(row)}</Text>
    </Box>
  );
}

/** A labelled block of counted lines (actions-by-rule, top paths) with a "+N more" tail. */
function CountList({
  title,
  rows,
  error,
  empty,
  max = 12,
}: {
  title: string;
  rows: { label: string; count: number }[];
  error?: string;
  empty?: string;
  max?: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {error ? (
        <Text dimColor wrap="truncate">
          (skipped — {error})
        </Text>
      ) : rows.length ? (
        <>
          {rows.slice(0, max).map((x) => (
            <Text
              key={x.label}
              wrap="truncate"
            >{`${String(x.count).padStart(8)}  ${x.label}`}</Text>
          ))}
          {rows.length > max && (
            <Text dimColor>{`  +${rows.length - max} more`}</Text>
          )}
        </>
      ) : (
        <Text dimColor>{empty ?? '(none)'}</Text>
      )}
    </Box>
  );
}

/** One path's per-IP peak distribution: ceilings, the measured worst case, then a bar per IP. */
function DistributionBlock({ dist }: { dist: Distribution }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold wrap="truncate">
        per-IP · {dist.label}
      </Text>
      {dist.skipped ? (
        <Text dimColor wrap="truncate">
          (skipped — {dist.skipped})
        </Text>
      ) : dist.empty ? (
        <Text dimColor>(no traffic)</Text>
      ) : (
        <>
          <Text dimColor wrap="truncate">
            {distHeader(dist)}
          </Text>
          <Text dimColor wrap="truncate">
            {distPeaks(dist)}
          </Text>
          {(dist.rows ?? []).slice(0, 6).map((r) => (
            <DistLine key={r.ip} row={r} dist={dist} />
          ))}
          {(dist.rows ?? []).length > 6 && (
            <Text dimColor>{`  +${(dist.rows ?? []).length - 6} more`}</Text>
          )}
        </>
      )}
    </Box>
  );
}

/** In-app firewall report view — the rule-tuning data (actions-by-rule, top paths, per-IP peaks), opened with 'r' from the rule list and shown in the side pane. Compact by design. */
export function ReportView({
  report,
  error,
  loading,
}: {
  report: ReportData | null;
  error: string;
  loading: boolean;
}) {
  if (!report)
    return error ? (
      <Box flexDirection="column">
        <Text color="red" wrap="truncate">
          Report failed: {error}
        </Text>
        <Text dimColor>esc rules · r retry · q quit</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text>Loading report…</Text>
        <Text dimColor>esc → rules (keeps loading) · q quit</Text>
      </Box>
    );
  const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate">
        report — {fmt(report.start)} → {fmt(report.now)}
        {loading ? ' · refreshing…' : ''}
      </Text>
      {error && (
        <Text color="red" wrap="truncate">
          refresh failed — {error}
        </Text>
      )}

      <CountList
        title="actions by rule (rl-* = a limit fired)"
        rows={report.byRule}
        error={report.byRuleError}
        empty="(no firewall actions)"
      />
      <CountList
        title="top request paths"
        rows={report.topPaths.map((p) => ({ label: p.path, count: p.count }))}
        error={report.topPathsError}
      />

      {report.distributions.map((d) => (
        <DistributionBlock key={d.label} dist={d} />
      ))}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>↑/↓ scroll · esc rules · r refresh · q quit</Text>
      </Box>
    </Box>
  );
}
