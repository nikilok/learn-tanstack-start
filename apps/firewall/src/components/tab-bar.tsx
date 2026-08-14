// The IP tab chips. The bar is windowed by `tabWindow` because overflowing the row makes Ink wrap
// it and the whole bar disappears, leaving no sign of which tab is active.

import { Box, Text } from 'ink';

import type { IpTab, IpTabs } from '../hooks/useIpTabs';

/**
 * A tab's chip text. A JA4 is 36 chars, so it is shortened — head AND tail, because the head
 * alone is the least distinguishing part of it: the first section is the TLS version and ALPN
 * summary, shared by every client built on the same stack, so two unrelated scrapers drew
 * identical chips. The trailing extension hash is what tells them apart.
 */
export function tabLabel(t: IpTab): string {
  const v = t.subject.value;
  // Short values unchanged: head-plus-tail on something already shorter than the two slices
  // returns a LONGER string than it was given, which is the opposite of shortening it.
  return t.subject.kind === 'ja4' && v.length > 17
    ? `${v.slice(0, 10)}…${v.slice(-6)}`
    : v;
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
