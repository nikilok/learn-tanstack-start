// Presentational components for the rule list — the left-hand editor: one row per WAF rule
// plus the apply-outcome tally. Pure (props in, no state/effects).

import { Box, Text } from 'ink';

import { actionColor } from '../actions';
import type { ApplyStatus, Item } from '../client';

// Which screen the editor is showing. Lives here, not app.tsx, to avoid an import cycle.
// No terminal 'done' phase — applying returns to 'select', so only 'q' ends the session.
export type Phase = 'loading' | 'select' | 'action' | 'applying' | 'fatal';

/** Truncate a string to `n` chars with a trailing ellipsis. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One-line tally of apply outcomes. Takes statuses, not items — the applyAll snapshot predates its own updates. */
export function summaryLine(statuses: ApplyStatus[]): string {
  const n = (s: ApplyStatus) => statuses.filter((x) => x === s).length;
  const parts: string[] = [];
  if (n('overwrote')) parts.push(`${n('overwrote')} overwrote`);
  if (n('inserted')) parts.push(`${n('inserted')} inserted`);
  if (n('error')) parts.push(`${n('error')} error`);
  return parts.join(', ') || 'no changes';
}

// Cursor (2) + checkbox (4) + a space after the name (1) + the action tag (12).
const ROW_FIXED = 19;
const MIN_NAME = 8;
const MIN_TAIL = 8; // below this a description says nothing, so the name gets the room instead

/** Name and tail widths for a row of `width` columns. Names keep their full length while there is room, then shrink before the tail does — the name is what identifies the rule. */
export function rowWidths(
  width: number,
  longestName: number,
): { name: number; tail: number } {
  const avail = Math.max(0, width - ROW_FIXED);
  const name = Math.max(MIN_NAME, Math.min(longestName, avail - MIN_TAIL));
  const tail = avail - name;
  // A sliver of description reads as noise, so drop it and spend the room on the name.
  if (tail < MIN_TAIL)
    return { name: Math.max(MIN_NAME, Math.min(longestName, avail)), tail: 0 };
  return { name, tail };
}

/** A row's tail: its apply status once it has one, else its description. An edited row resets to idle, marking it unapplied. */
function RowTail({
  item,
  phase,
  width,
  pending,
}: {
  item: Item;
  phase: Phase;
  width: number;
  pending?: string;
}) {
  // An edit that is staged but unapplied must announce itself, or the operator cannot tell a
  // keypress landed. It outranks the description, which never changes.
  if (phase !== 'applying' && item.status === 'idle' && pending)
    return <Text color="yellow">{truncate(`● ${pending}`, width)}</Text>;
  if (phase !== 'applying' && item.status === 'idle')
    return <Text dimColor>{truncate(item.rule.description, width)}</Text>;
  const suffix = item.detail ? ` (${item.detail})` : '';
  switch (item.status) {
    case 'applying':
      return <Text color="yellow">… applying</Text>;
    case 'inserted':
      return <Text color="green">{truncate(`＋ inserted${suffix}`, width)}</Text>;
    case 'overwrote':
      return <Text color="green">{truncate(`✔ overwrote${suffix}`, width)}</Text>;
    case 'error':
      return (
        <Text color="red">{truncate(`✖ ${item.detail ?? 'error'}`, width)}</Text>
      );
    default:
      return <Text dimColor>pending</Text>;
  }
}

/** A single rule row: cursor marker, active checkbox, name, action tag, then description/status. Sized to `width` so it stays on one line — a wrapped row desyncs the list from the cursor. */
export function Row({
  item,
  isCursor,
  phase,
  width,
  longestName,
  pending,
}: {
  item: Item;
  isCursor: boolean;
  phase: Phase;
  width: number;
  longestName: number;
  pending?: string;
}) {
  const selecting = phase === 'select' || phase === 'action';
  const w = rowWidths(width, longestName);
  return (
    <Box>
      <Text color="cyan">{isCursor && selecting ? '▶ ' : '  '}</Text>
      <Text color={item.active ? 'green' : 'gray'}>
        {item.active ? '[x]' : '[ ]'}{' '}
      </Text>
      <Text bold>{truncate(item.rule.name, w.name).padEnd(w.name)} </Text>
      <Text color={item.active ? actionColor(item.action) : 'gray'}>
        {`[${item.action.toUpperCase()}]`.padEnd(11)}{' '}
      </Text>
      {w.tail > 0 && (
        <RowTail item={item} phase={phase} width={w.tail} pending={pending} />
      )}
    </Box>
  );
}
