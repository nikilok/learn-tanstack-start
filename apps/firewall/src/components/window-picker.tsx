// The timeline list: the presets, plus the custom-range row beneath them.

import { Box, Text } from 'ink';

import { WINDOW_PRESETS } from '../time-window';
import { isCustomRow } from '../window-pick';
import { FooterHints } from './footer-hints';

export function WindowPicker({
  cursor,
  /** Which row is in force — a preset index, or CUSTOM for a typed range. */
  presetIdx,
}: {
  cursor: number;
  presetIdx: number;
}) {
  const windowCursor = cursor;
  return (
    <Box flexDirection="column">
      <Text dimColor>{'  '}timeline</Text>
      {WINDOW_PRESETS.map((p, i) => (
        <Box key={p.label}>
          <Text color="cyan">{i === windowCursor ? '▶ ' : '  '}</Text>
          <Text
            bold={i === windowCursor}
            color={i === windowCursor ? 'cyan' : undefined}
            dimColor={i !== windowCursor}
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
        <Text color="cyan">{isCustomRow(windowCursor) ? '▶ ' : '  '}</Text>
        <Text
          bold={isCustomRow(windowCursor)}
          color={isCustomRow(windowCursor) ? 'cyan' : undefined}
          dimColor={!isCustomRow(windowCursor)}
        >
          {'custom…'.padEnd(10)}
        </Text>
        <Text dimColor>type dates{presetIdx < 0 ? '  ·  in force' : ''}</Text>
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
