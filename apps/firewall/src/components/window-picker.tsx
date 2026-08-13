// The timeline list: the presets, plus the custom-range row beneath them.

import { Box, Text } from 'ink';

import { WINDOW_PRESETS } from '../time-window';
import { CUSTOM, isCustomRow } from '../window-pick';
import { FooterHints } from './footer-hints';

export function WindowPicker({
  cursor,
  /** Which row is in force — a preset index, or CUSTOM for a typed range. */
  presetIdx,
}: {
  cursor: number;
  presetIdx: number;
}) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{'  '}timeline</Text>
      {WINDOW_PRESETS.map((p, i) => (
        <Box key={p.label}>
          <Text color="cyan">{i === cursor ? '▶ ' : '  '}</Text>
          <Text
            bold={i === cursor}
            color={i === cursor ? 'cyan' : undefined}
            dimColor={i !== cursor}
          >
            {p.label.padEnd(10)}
          </Text>
          <Text dimColor>
            {p.minutes < 60 ? `${p.minutes}m` : `${p.minutes / 60}h`}
            {i === presetIdx ? '  ·  in force' : ''}
          </Text>
        </Box>
      ))}
      <Box>
        <Text color="cyan">{isCustomRow(cursor) ? '▶ ' : '  '}</Text>
        <Text
          bold={isCustomRow(cursor)}
          color={isCustomRow(cursor) ? 'cyan' : undefined}
          dimColor={!isCustomRow(cursor)}
        >
          {'custom…'.padEnd(10)}
        </Text>
        <Text dimColor>
          type dates{presetIdx === CUSTOM ? '  ·  in force' : ''}
        </Text>
      </Box>
      <Text wrap="wrap">
        {'  '}
        <FooterHints
          hints={[
            { key: '↑↓', label: 'choose' },
            { key: 'enter', label: 'apply' },
            { key: 'esc', label: 'cancel' },
          ]}
        />
      </Text>
    </Box>
  );
}
