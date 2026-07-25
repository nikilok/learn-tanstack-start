// Presentational components for the rule list — the left-hand editor: one row per WAF rule
// plus the apply-outcome tally. Pure (props in, no state/effects).

import { Box, Text } from 'ink';

import { actionColor } from './actions';
import type { ApplyStatus, Item } from './client';

// Which screen the editor is showing. Lives here rather than in app.tsx (which owns the
// state) because Row/RowTail need it and importing back from app.tsx would be a cycle.
// No terminal 'done' phase: applying returns to 'select' so the session continues, and only
// 'q' ends it. 'fatal' stays terminal because there is no config loaded to work with.
export type Phase = 'loading' | 'select' | 'action' | 'applying' | 'fatal';

/** Truncate a string to `n` chars with a trailing ellipsis. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
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
