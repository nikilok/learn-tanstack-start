// The list a mock session opens with: which recorded corpus to replay.
//
// Shown before the app rather than inside it, because the cassette decides what every pane will
// say. Choosing it after the panes have already drawn themselves from another one is how you end
// up reading the wrong traffic.

import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';

import type { Choice } from './boot';
import { type CassetteInfo, ageLabel, sizeLabel } from './cassette-store';

export type Row = { label: string; detail: string; choice: Choice };

/** The rows the picker offers, one per recorded corpus. There is deliberately no "none" row: a mock session with nothing to replay reads identically to a working one over a quiet window, so an empty drawer is refused before the picker is ever shown. */
export function rowsFor(available: readonly CassetteInfo[]): Row[] {
  return available.map((info) => ({
    label: info.name,
    detail: `${sizeLabel(info.bytes)} · recorded ${ageLabel(info.ageDays)}`,
    choice: { kind: 'cassette' as const, info },
  }));
}

/** Move a cursor within `length`, stopping at both ends rather than wrapping — a list this short reads as a menu, and wrapping past the end loses your place. */
export function moveCursor(
  cursor: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, cursor + delta));
}

export function CassettePicker(opts: {
  available: readonly CassetteInfo[];
  onPick: (choice: Choice) => void;
}) {
  const rows = rowsFor(opts.available);
  const [cursor, setCursor] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow || input === 'k')
      setCursor((c) => moveCursor(c, -1, rows.length));
    else if (key.downArrow || input === 'j')
      setCursor((c) => moveCursor(c, 1, rows.length));
    else if (key.return) {
      opts.onPick(rows[cursor].choice);
      exit();
    } else if (input === 'q' || key.escape) {
      opts.onPick({ kind: 'quit' });
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Firewall </Text>
        <Text color="magenta" inverse>
          (MOCK)
        </Text>
        <Text dimColor> · pick a cassette to replay</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => (
          <Box key={row.label}>
            <Text color={i === cursor ? 'cyan' : undefined}>
              {i === cursor ? '▶ ' : '  '}
            </Text>
            <Text bold={i === cursor}>{row.label}</Text>
            <Text dimColor> · {row.detail}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · enter pick · q quit</Text>
      </Box>
    </Box>
  );
}
