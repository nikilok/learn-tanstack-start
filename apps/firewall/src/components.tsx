// Presentational Ink components for the rule manager — pure (props in, no state/effects).

import { Box, Text } from 'ink';

import { actionColor } from './actions';
import type { Item } from './client';
import type { ReportData } from './report-data';

export type Phase =
  | 'loading'
  | 'select'
  | 'action'
  | 'applying'
  | 'done'
  | 'fatal';

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

/** Bar colour by proximity to the rate limit: green safe · yellow watch · red near/over; neutral cyan when no limit is configured. */
function barColor(value: number, limit?: number): string {
  if (!limit || limit <= 0) return 'cyan';
  const r = value / limit;
  return r >= 0.8 ? 'red' : r >= 0.5 ? 'yellow' : 'green';
}

/** Header for a distribution: the rate-limit ceiling, IP count, and the busiest IP as a % of the limit. */
function distHeader(d: ReportData['distributions'][number]): string {
  const ips = `${d.ips}${d.capped ? '+' : ''} IP${d.ips === 1 ? '' : 's'}`;
  if (!d.limit) return `${ips} · max ${(d.max ?? 0).toFixed(2)}/min`;
  const peak = (((d.max ?? 0) / d.limit) * 100).toFixed(1);
  return `limit ${d.limit}/min · ${ips} · peak ${peak}%`;
}

/** One-line tally of apply outcomes for the done screen. */
export function summaryLine(items: Item[]): string {
  const n = (s: Item['status']) => items.filter((it) => it.status === s).length;
  const parts: string[] = [];
  if (n('overwrote')) parts.push(`${n('overwrote')} overwrote`);
  if (n('inserted')) parts.push(`${n('inserted')} inserted`);
  if (n('error')) parts.push(`${n('error')} error`);
  return parts.join(', ') || 'no changes';
}

/** The right-hand side of a rule row: its description while selecting, its apply status otherwise. */
function RowTail({ item, phase }: { item: Item; phase: Phase }) {
  if (phase === 'select' || phase === 'action')
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
              {(d.rows ?? []).slice(0, 6).map((r) => (
                <Box key={r.ip}>
                  <Text color={barColor(r.perMin, d.limit)}>
                    {`${usageBar(r.perMin, d.max ?? 0)} `}
                  </Text>
                  <Text wrap="truncate">{`${r.perMin.toFixed(2)}/min  ${r.ip}`}</Text>
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
