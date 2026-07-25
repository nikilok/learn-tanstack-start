// Presentational Ink components for the rule manager — pure (props in, no state/effects).

import { Box, Text } from 'ink';

import { actionColor } from './actions';
import type { ApplyStatus, Item } from './client';
import type { DistRow, ReportData } from './report-data';

// No terminal 'done' phase: applying returns to 'select' so the session continues, and only
// 'q' ends it. 'fatal' stays terminal because there is no config loaded to work with.
export type Phase = 'loading' | 'select' | 'action' | 'applying' | 'fatal';

/** Truncate a string to `n` chars with a trailing ellipsis. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

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
function distHeader(d: ReportData['distributions'][number]): string {
  const ips = `${d.ips}${d.capped ? '+' : ''} IP${d.ips === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (d.limit) parts.push(`limit ${d.limit}/min`);
  if (d.sustainedLimit) parts.push(`sust ${d.sustainedLimit}/10m`);
  parts.push(ips);
  return parts.join(' · ');
}

/** Measured worst case against those ceilings, plus what the claim actually covers: `exact`/`floor` applies only to the top-N IPs by volume that were measured, never to every IP on the path, and an unmeasured low-volume client could always have burst higher. */
function distPeaks(d: ReportData['distributions'][number]): string {
  const pct = (v: number, lim?: number) =>
    lim ? ` (${((v / lim) * 100).toFixed(0)}%)` : '';
  const min = `${d.maxPeakMin ?? 0}/min${pct(d.maxPeakMin ?? 0, d.limit)}`;
  const ten = `${d.maxPeak10m ?? 0}/10m${pct(d.maxPeak10m ?? 0, d.sustainedLimit)}`;
  const n = d.sampledWindows ?? 0;
  const how = d.exact ? 'exact' : 'floor'; // floor = the round cap stopped the search early
  return `peak ${min} · ${ten} · ${how} over top ${d.measuredIps ?? 0} IPs, ${n} window${n === 1 ? '' : 's'} zoomed`;
}

/** One IP's line: `  99/min   227/10m   917  1.2.3.4`. Unresolved bursts are never printed as a bare number: `108+` means at least that much was observed, `<=63` means it was never opened up but provably cannot exceed that (refining it would not have changed the leader), and an unmeasured IP dashes BOTH peak columns — a bare `0/10m` reads as a measurement. The trailing total is whole-window volume, the signal that exposes slow wide enumeration whose per-minute and per-10-minute figures both look ordinary. */
function distRow(r: DistRow): string {
  if (!r.sampled)
    return `${'—'.padStart(6)}/min ${'—'.padStart(5)}/10m ${compact(r.total).padStart(6)}  ${r.ip}`;
  const min = r.peakMinExact
    ? String(r.peakMin)
    : r.peakMin > 0
      ? `${r.peakMin}+`
      : `<=${r.peakMinBound}`;
  return `${min.padStart(6)}/min ${String(r.peak10m).padStart(5)}/10m ${compact(r.total).padStart(6)}  ${r.ip}`;
}

/** One-line tally of apply outcomes. Takes the statuses the apply actually produced, not the items — the snapshot handed to applyAll predates its own updates, so counting from it would always read 'idle'. */
export function summaryLine(statuses: ApplyStatus[]): string {
  const n = (s: ApplyStatus) => statuses.filter((x) => x === s).length;
  const parts: string[] = [];
  if (n('overwrote')) parts.push(`${n('overwrote')} overwrote`);
  if (n('inserted')) parts.push(`${n('inserted')} inserted`);
  if (n('error')) parts.push(`${n('error')} error`);
  return parts.join(', ') || 'no changes';
}

/** The right-hand side of a rule row: its apply status once it has one (which outlives the apply, so the outcome stays readable while the session continues), otherwise its description. A row edited since the last apply is reset to idle and shows its description again, marking it unapplied. */
function RowTail({ item, phase }: { item: Item; phase: Phase }) {
  if (phase !== 'applying' && item.status === 'idle')
    return <Text dimColor>{truncate(item.rule.description, 50)}</Text>;
  const suffix = item.detail ? ` (${item.detail})` : '';
  switch (item.status) {
    case 'applying':
      return <Text color="yellow">… applying</Text>;
    case 'inserted':
      return <Text color="green">＋ inserted{suffix}</Text>;
    case 'overwrote':
      return <Text color="green">✔ overwrote{suffix}</Text>;
    case 'error':
      return <Text color="red">✖ {item.detail ?? 'error'}</Text>;
    default:
      return <Text dimColor>pending</Text>;
  }
}

/** A single rule row: cursor marker, active checkbox, name, action tag, then description/status. */
export function Row({
  item,
  isCursor,
  phase,
}: {
  item: Item;
  isCursor: boolean;
  phase: Phase;
}) {
  const selecting = phase === 'select' || phase === 'action';
  return (
    <Box>
      <Text color="cyan">{isCursor && selecting ? '▶ ' : '  '}</Text>
      <Text color={item.active ? 'green' : 'gray'}>
        {item.active ? '[x]' : '[ ]'}{' '}
      </Text>
      <Text bold>{item.rule.name.padEnd(20)} </Text>
      <Text color={item.active ? actionColor(item.action) : 'gray'}>
        {`[${item.action.toUpperCase()}]`.padEnd(11)}{' '}
      </Text>
      <RowTail item={item} phase={phase} />
    </Box>
  );
}

/** In-app firewall report view — the rule-tuning data (actions-by-rule, top paths, per-IP /min), opened with 'r' from the rule list and shown in the side pane. Compact by design. */
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

      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">
          actions by rule (rl-* = a limit fired)
        </Text>
        {report.byRuleError ? (
          <Text dimColor wrap="truncate">
            (skipped — {report.byRuleError})
          </Text>
        ) : report.byRule.length ? (
          <>
            {report.byRule.slice(0, 12).map((x) => (
              <Text
                key={x.label}
                wrap="truncate"
              >{`${String(x.count).padStart(8)}  ${x.label}`}</Text>
            ))}
            {report.byRule.length > 12 && (
              <Text dimColor>{`  +${report.byRule.length - 12} more`}</Text>
            )}
          </>
        ) : (
          <Text dimColor>(no firewall actions)</Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">
          top request paths
        </Text>
        {report.topPathsError ? (
          <Text dimColor wrap="truncate">
            (skipped — {report.topPathsError})
          </Text>
        ) : (
          <>
            {report.topPaths.slice(0, 12).map((p) => (
              <Text
                key={p.path}
                wrap="truncate"
              >{`${String(p.count).padStart(8)}  ${p.path}`}</Text>
            ))}
            {report.topPaths.length > 12 && (
              <Text dimColor>{`  +${report.topPaths.length - 12} more`}</Text>
            )}
          </>
        )}
      </Box>

      {report.distributions.map((d) => (
        <Box key={d.label} flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate">
            per-IP · {d.label}
          </Text>
          {d.skipped ? (
            <Text dimColor wrap="truncate">
              (skipped — {d.skipped})
            </Text>
          ) : d.empty ? (
            <Text dimColor>(no traffic)</Text>
          ) : (
            <>
              <Text dimColor wrap="truncate">
                {distHeader(d)}
              </Text>
              <Text dimColor wrap="truncate">
                {distPeaks(d)}
              </Text>
              {(d.rows ?? []).slice(0, 6).map((r) => (
                <Box key={r.ip}>
                  <Text color={barColor(r, d.limit, d.sustainedLimit)}>
                    {`${usageBar(r.peakMin, d.maxPeakMin ?? 0)} `}
                  </Text>
                  <Text wrap="truncate">{distRow(r)}</Text>
                </Box>
              ))}
              {(d.rows ?? []).length > 6 && (
                <Text dimColor>{`  +${(d.rows ?? []).length - 6} more`}</Text>
              )}
            </>
          )}
        </Box>
      ))}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>↑/↓ scroll · esc rules · r refresh · q quit</Text>
      </Box>
    </Box>
  );
}
