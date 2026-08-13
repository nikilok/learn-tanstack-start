// The watch-mode panel under the rules list: whether the loop is running, what the last tick saw,
// and the investigation it produced.

import { Box, Text } from 'ink';

import type { Watch } from '../hooks/useWatch';
import { watchTiming } from '../tuning';
import { WATCH_LOG } from '../watch-log';

/** Status for an armed watch loop. Renders nothing when it is not. */
export function WatchStatus({ watch: w }: { watch: Watch }) {
  if (!w.on) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={w.busy ? 'yellow' : 'green'} bold>
          ◉ watch{' '}
        </Text>
        <Text dimColor>
          {watchTiming() ??
            'window unset — set FW_WATCH_HOURS and FW_WATCH_INTERVAL_MIN'}
          {w.at ? ` · last ${w.at}` : ' · starting…'}
          {w.keepingAwake ? ' · holding the mac awake' : ''}
        </Text>
      </Text>
      {Boolean(w.note) && (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {w.note}
        </Text>
      )}
      {/* Name them, or "1 profiled" sends the operator digging through the log. */}
      {w.who.map((w) => (
        <Text key={w} dimColor wrap="truncate-end">
          {'    '}
          {w}
        </Text>
      ))}
      {/* Stays up once it has happened. The loop runs while you are in another pane, so an
          invocation you were not watching still has to be visible afterwards. */}
      {w.invokedCount > 0 && (
        <Text>
          <Text color="magenta" bold>
            {'  '}⇢ claude invoked{' '}
          </Text>
          <Text dimColor>
            {w.invokedCount}× this session · last {w.invokedAt}
            {w.notifiedAt ? ` · notified ${w.notifiedAt}` : ''} · {WATCH_LOG}
          </Text>
        </Text>
      )}
      {w.invokedCount === 0 && Boolean(w.at) && (
        <Text dimColor>
          {'  '}logging to {WATCH_LOG}
        </Text>
      )}
      {/* Not truncated: a verdict is the one thing here worth reading in full, and a
          clipped one is worse than none — it reads as complete. */}
      {Boolean(w.verdictHead) && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            investigation{' '}
            {w.verdictOf ? <Text dimColor>{w.verdictOf}</Text> : null}
          </Text>
          {/* Clamped. This pane's height is reserved in advance, and an unbounded verdict
              overflows the frame — which scrolls the terminal and hides the editor cursor,
              the same defect reportH and the pane height already exist to prevent. */}
          <Text>{w.verdictHead}</Text>
          {w.verdictClipped > 0 && (
            <Text dimColor>
              {'  '}… {w.verdictClipped} more line(s) — full text in {WATCH_LOG}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
