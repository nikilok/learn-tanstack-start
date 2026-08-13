// The harness's own failure mode is silent: a component renders perfectly while every keypress
// is dropped, so every test built on it passes its render assertions and asserts nothing about
// input. That is exactly what ink-testing-library does against Ink 7, so it is tested here.

import { describe, expect, test } from 'bun:test';

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { KEY, renderInk } from './ink-harness';

function Probe() {
  const [log, setLog] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  useInput((input, key) => {
    if (key.escape) setLog((l) => [...l, 'escape']);
    else if (key.upArrow) setLog((l) => [...l, 'up']);
    else if (key.downArrow) setLog((l) => [...l, 'down']);
    else if (key.return) setLog((l) => [...l, 'enter']);
    else if (key.tab) setLog((l) => [...l, key.shift ? 'shift-tab' : 'tab']);
    else if (key.pageDown) setLog((l) => [...l, 'pagedown']);
    else if (key.backspace || key.delete) setTyped((s) => s.slice(0, -1));
    else setTyped((s) => s + input);
  });
  return (
    <Box flexDirection="column">
      <Text>typed:{typed}</Text>
      <Text>keys:{log.join(',')}</Text>
    </Box>
  );
}

describe('renderInk', () => {
  test('renders a first frame before any input', async () => {
    const h = renderInk(<Probe />);
    await h.settle();
    expect(h.frame()).toContain('typed:');
    h.unmount();
  });

  test('printable keys reach useInput in order', async () => {
    const h = renderInk(<Probe />);
    await h.press('a');
    await h.press('b');
    expect(h.frame()).toContain('typed:ab');
    h.unmount();
  });

  test('a pasted chunk arrives whole, as the TUI treats it', async () => {
    // The IP field filters within the chunk rather than testing the whole string, because a
    // paste is one event. A harness that split it would hide that.
    const h = renderInk(<Probe />);
    await h.press('1.2.3.4');
    expect(h.frame()).toContain('typed:1.2.3.4');
    h.unmount();
  });

  test('every bound escape sequence decodes to the key it names', async () => {
    const h = renderInk(<Probe />);
    for (const k of [KEY.up, KEY.down, KEY.enter, KEY.tab, KEY.pageDown])
      await h.press(k);
    expect(h.frame()).toContain('keys:up,down,enter,tab,pagedown');
    h.unmount();
  });

  test('a bare escape resolves as escape, not as a dropped sequence', async () => {
    // Ink holds it back for 20ms to tell it from the start of a sequence. A harness that did not
    // outwait that would silently never deliver esc — which every pane uses to go back.
    const h = renderInk(<Probe />);
    await h.press(KEY.escape);
    expect(h.frame()).toContain('keys:escape');
    h.unmount();
  });

  test('shift-tab is distinguished from tab', async () => {
    const h = renderInk(<Probe />);
    await h.press(KEY.shiftTab);
    expect(h.frame()).toContain('keys:shift-tab');
    h.unmount();
  });

  test('backspace deletes rather than typing a character', async () => {
    const h = renderInk(<Probe />);
    await h.press('ab');
    await h.press(KEY.backspace);
    expect(h.frame()).toContain('typed:a');
    h.unmount();
  });

  test('frames() keeps the history, so a transition can be asserted', async () => {
    const h = renderInk(<Probe />);
    await h.press('x');
    const all = h.frames();
    expect(all.length).toBeGreaterThan(1);
    expect(all.at(-1)).toContain('typed:x');
    h.unmount();
  });

  test('frames carry no ANSI, so assertions read as plain text', async () => {
    const h = renderInk(
      <Text color="red" bold>
        alarm
      </Text>,
    );
    await h.settle();
    expect(h.frame()).toContain('alarm');
    expect(h.frame()).not.toContain('[');
    h.unmount();
  });

  test('the requested width reaches the layout process.stdout is read for', async () => {
    // Read during render, which is where the pane widths are computed — not at call time, when
    // the patch is not in place yet.
    const Width = () => <Text>cols={process.stdout.columns}</Text>;
    const h = renderInk(<Width />, { columns: 80 });
    await h.settle();
    expect(h.frame()).toContain('cols=80');
    h.unmount();
  });

  test('unmount restores the real terminal size', async () => {
    const before = process.stdout.columns;
    const h = renderInk(<Text>x</Text>, { columns: 37 });
    await h.settle();
    h.unmount();
    expect(process.stdout.columns).toBe(before);
  });
});
