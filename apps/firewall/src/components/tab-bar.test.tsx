// The row this bar occupies is reserved by paneChrome for the IP pane ONLY. Drawn on any other
// pane it is an unreserved line, the frame outgrows the viewport, and the terminal scrolls the
// header and the editor cursor away — the failure the whole layout is built to avoid.

import { describe, expect, test } from 'bun:test';

import type { IpTabs } from '../hooks/useIpTabs';
import { renderInk } from '../ink-harness';
import { TabBar, tabLabel } from './tab-bar';

const tab = (value: string, loading = false) => ({
  subject: { kind: 'ja4' as const, value },
  window: {} as never,
  data: null,
  error: '',
  loading,
});

const tabs = (...values: string[]) =>
  ({ tabs: values.map((v) => tab(v)), index: 0 }) as unknown as IpTabs;

const WINDOW = { start: 0, end: 2, left: false, right: false };

async function frameOf(show: boolean, t: IpTabs) {
  const h = renderInk(
    <TabBar show={show} ipTabs={t} tabBar={WINDOW} isLive={false} blink />,
    { columns: 80 },
  );
  await h.settle();
  const f = h.frame();
  h.unmount();
  return f;
}

describe('TabBar', () => {
  test('renders the chips on the IP pane', async () => {
    expect(
      await frameOf(true, tabs('t13d1516h2_8daaf6152771_b0da82dd1658')),
    ).toContain('t13d1516h2_8da');
  });

  // The regression: the bar guarded only on tab count once it was extracted, so open tabs made it
  // appear on the report, bans and list panes too.
  test('renders NOTHING on any other pane, even with tabs open', async () => {
    expect(
      (
        await frameOf(false, tabs('t13d1516h2_8daaf6152771_b0da82dd1658'))
      ).trim(),
    ).toBe('');
  });

  test('renders nothing when there are no tabs', async () => {
    expect((await frameOf(true, tabs())).trim()).toBe('');
  });
});

describe('tabLabel', () => {
  test('a JA4 is shortened to its distinguishing head', () => {
    const label = tabLabel(tab('t13d1516h2_8daaf6152771_b0da82dd1658'));
    expect(label.length).toBeLessThan(20);
    expect(label).toContain('t13d1516h2');
  });

  test('an IP is shown whole — it already fits', () => {
    expect(
      tabLabel({ ...tab('x'), subject: { kind: 'ip', value: '1.2.3.4' } }),
    ).toBe('1.2.3.4');
  });
});
