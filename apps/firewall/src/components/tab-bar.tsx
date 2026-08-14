// The IP tab chips. The bar is windowed by `tabWindow` because overflowing the row makes Ink wrap
// it and the whole bar disappears, leaving no sign of which tab is active.

import { Box, Text } from 'ink';

import type { IpTab, IpTabs } from '../hooks/useIpTabs';

/** A tab's chip text. A JA4 is 37 chars, so it is shortened to its distinguishing head. */
export function tabLabel(t: IpTab): string {
  return t.subject.kind === 'ja4'
    ? `${t.subject.value.slice(0, 14)}…`
    : t.subject.value;
}

export function TabBar({
  show,
  ipTabs,
  tabBar,
  isLive,
  blink,
}: {
  /** Whether the IP pane is the one on screen. The row is only RESERVED for that pane, so drawing it anywhere else grows the frame past the viewport. */
  show: boolean;
  ipTabs: IpTabs;
  tabBar: { start: number; end: number; left: boolean; right: boolean };
  isLive: boolean;
  /** Drives the live marker, so a watch screen reads as live rather than frozen. */
  blink: boolean;
}) {
  if (!show || !ipTabs.tabs.length) return null;
  return (
    <Box>
      {isLive && (
        <Text color={blink ? 'red' : 'gray'} bold>
          ●{' '}
        </Text>
      )}
      {tabBar.left && (
        <Text color="cyan" bold>
          ‹{' '}
        </Text>
      )}
      {ipTabs.tabs.slice(tabBar.start, tabBar.end).map((t, j) => {
        const i = tabBar.start + j;
        const chip =
          i === ipTabs.index ? `[${tabLabel(t)}]` : ` ${tabLabel(t)} `;
        return (
          <Text
            key={`${t.subject.kind}:${t.subject.value}`}
            bold={i === ipTabs.index}
            color={i === ipTabs.index ? 'cyan' : undefined}
            dimColor={i !== ipTabs.index}
            // Clips a lone chip too wide for the row; without this it wraps and Ink
            // loses the whole bar.
            wrap="truncate-end"
          >
            {chip}
            {t.loading ? '…' : ''}{' '}
          </Text>
        );
      })}
      {tabBar.right && (
        <Text color="cyan" bold>
          {' '}
          ›
        </Text>
      )}
    </Box>
  );
}
