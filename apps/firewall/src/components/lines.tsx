// Ink renderer for the shared line model. One <Text> per line with truncate-end so a wide table
// clips instead of wrapping, which would break the bar charts and desync scroll measurement.

import { Box, Text } from 'ink';

import { type Line, type Tone, truncate } from '../line-model';

const COLOUR: Partial<Record<Tone, string>> = {
  good: 'green',
  bad: 'red',
  warn: 'yellow',
  key: 'cyan',
};

/** Render pre-built lines, clipped to `width` columns when given. */
export function Lines({ lines, width }: { lines: Line[]; width?: number }) {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => {
        const clipped = width ? truncate(l, width) : l;
        return (
          // Index key: these are positional rows of a rendered report, never reordered.
          <Text key={i} wrap="truncate-end">
            {clipped.length === 0
              ? ' '
              : clipped.map((s, j) => (
                  <Text
                    key={j}
                    dimColor={s.tone === 'dim'}
                    bold={s.tone === 'bold'}
                    color={s.tone ? COLOUR[s.tone] : undefined}
                  >
                    {s.text}
                  </Text>
                ))}
          </Text>
        );
      })}
    </Box>
  );
}
