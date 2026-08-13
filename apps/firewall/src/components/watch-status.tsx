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
    // Boxed so an armed loop reads as its own panel rather than more footer. The border carries
    // the state the ◉ marker already shows — amber mid-tick, green between them — so whether it
    // is working is legible from the shape at the edge of your eye, without reading a word.
    //
    // The background assumes a DARK terminal, which is the only hard-coded assumption of its kind
    // in this tool; every other colour is a named ANSI one that follows the theme. On a light
    // terminal drop `backgroundColor` and the border alone still separates it.
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingX={1}
      borderStyle="round"
      borderColor={w.busy ? 'yellow' : 'green'}
      backgroundColor="#151b23"
    >
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
        // Wrapped, not truncated: the border costs four columns and this line carries the actual
        // result — "0 profiled · 0 would ban" was the half being clipped away.
        <Text dimColor wrap="wrap">
          {w.note}
        </Text>
      )}
      {/* Name them, or "1 profiled" sends the operator digging through the log. */}
      {w.who.map((who) => (
        <Text key={who} dimColor wrap="truncate-end">
          {'    '}
          {who}
        </Text>
      ))}
      {/* Stays up once it has happened. The loop runs while you are in another pane, so an
          invocation you were not watching still has to be visible afterwards. */}
      {w.invokedCount > 0 && (
        <Text>
          <Text color="magenta" bold>
            ⇢ claude invoked{' '}
          </Text>
          <Text dimColor>
            {w.invokedCount}× this session · last {w.invokedAt}
            {w.notifiedAt ? ` · notified ${w.notifiedAt}` : ''} · {WATCH_LOG}
          </Text>
        </Text>
      )}
      {w.invokedCount === 0 && Boolean(w.at) && (
        <Text dimColor>logging to {WATCH_LOG}</Text>
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
