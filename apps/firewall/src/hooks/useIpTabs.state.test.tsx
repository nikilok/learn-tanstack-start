// Opening an identity and getting its profile back is the single most-used path in the tool, and
// it had no hook-level test — only the pure helpers around it did. A guard added for a stale-fetch
// edge case then dropped EVERY patch on a first lookup, and the tab sat on "Loading IP profile…"
// for ever with nothing on screen saying anything was wrong.

import { afterEach, describe, expect, mock, test } from 'bun:test';

import { Text } from 'ink';
import { useEffect } from 'react';

import { renderInk } from '../ink-harness';
import type { IpProfile, Subject } from '../ip-profile';
import { rollingWindow } from '../time-window';

const CREDS = { projectId: 'p', teamId: 't', token: 'k' };
const WINDOW = rollingWindow(24, new Date('2026-08-14T06:00:00.000Z'));
const IP: Subject = { kind: 'ip', value: '1.2.3.4' };
const JA4: Subject = {
  kind: 'ja4',
  value: 't13d1516h2_8daaf6152771_b0da82dd1658',
};

/** A profile with just enough shape for the tab to render it. */
const profile = (subject: Subject, total: number) =>
  ({ subject, total, errors: [] }) as unknown as IpProfile;

afterEach(() => {
  mock.restore();
});

/**
 * Mount the hook with `fetchIpProfile` replaced, and hand it back to the test.
 *
 * The module is re-imported after the mock so the hook binds to the stub.
 */
async function mountTabs(fetch: (s: Subject) => Promise<IpProfile>) {
  const real = await import('../ip-profile');
  mock.module('../ip-profile', () => ({
    ...real,
    fetchIpProfile: async (_c: unknown, s: Subject) => fetch(s),
  }));
  const { useIpTabs } = await import('./useIpTabs');

  let api!: ReturnType<typeof useIpTabs>;
  function Probe() {
    const tabs = useIpTabs(CREDS);
    useEffect(() => {
      api = tabs;
    });
    const t = tabs.active;
    return (
      <Text>
        tabs={tabs.tabs.length} loading={String(Boolean(t?.loading))} total=
        {t?.data?.total ?? '-'} error={t?.error || '-'}
      </Text>
    );
  }
  const h = renderInk(<Probe />);
  await h.settle();
  return {
    h,
    get: () => api,
    restore: () => mock.module('../ip-profile', () => real),
  };
}

describe('useIpTabs', () => {
  test('a profile that resolves reaches the tab', async () => {
    const { h, get, restore } = await mountTabs(async (s) => profile(s, 900));
    try {
      get().open(IP, WINDOW);
      await h.settle();
      expect(h.frame()).toContain('tabs=1');
      expect(h.frame()).toContain('total=900');
      expect(h.frame()).toContain('loading=false');
    } finally {
      h.unmount();
      restore();
    }
  });

  // The regression: a JA4 opened from the picker sat on the spinner for ever.
  test('a JA4 opened for the first time loads, and does not sit on the spinner', async () => {
    const { h, get, restore } = await mountTabs(async (s) => profile(s, 417));
    try {
      get().open(JA4, WINDOW);
      await h.settle();
      expect(h.frame()).toContain('loading=false');
      expect(h.frame()).toContain('total=417');
    } finally {
      h.unmount();
      restore();
    }
  });

  test('a failed profile clears the spinner and shows the error', async () => {
    const { h, get, restore } = await mountTabs(async () => {
      throw new Error('metrics 504');
    });
    try {
      get().open(IP, WINDOW);
      await h.settle();
      expect(h.frame()).toContain('loading=false');
      expect(h.frame()).toContain('error=metrics 504');
    } finally {
      h.unmount();
      restore();
    }
  });

  test('opening a second subject adds a tab and focuses it', async () => {
    const { h, get, restore } = await mountTabs(async (s) =>
      profile(s, s.kind === 'ip' ? 900 : 417),
    );
    try {
      get().open(IP, WINDOW);
      await h.settle();
      get().open(JA4, WINDOW);
      await h.settle();
      expect(h.frame()).toContain('tabs=2');
      expect(h.frame()).toContain('total=417');
    } finally {
      h.unmount();
      restore();
    }
  });

  test('reopening a subject switches to it rather than adding a duplicate', async () => {
    const { h, get, restore } = await mountTabs(async (s) => profile(s, 900));
    try {
      get().open(IP, WINDOW);
      await h.settle();
      get().open(IP, WINDOW);
      await h.settle();
      expect(h.frame()).toContain('tabs=1');
    } finally {
      h.unmount();
      restore();
    }
  });

  // The edge the epoch guard exists for: a tab closed mid-fetch, then opened again.
  test('a subject closed while loading can be opened again and still loads', async () => {
    let release!: (p: IpProfile) => void;
    const first = new Promise<IpProfile>((r) => {
      release = r;
    });
    let call = 0;
    const { h, get, restore } = await mountTabs(async (s) =>
      ++call === 1 ? first : profile(s, 42),
    );
    try {
      get().open(IP, WINDOW);
      await h.settle();
      get().close();
      await h.settle();
      expect(h.frame()).toContain('tabs=0');

      get().open(IP, WINDOW);
      await h.settle();
      release(profile(IP, 999)); // the abandoned fetch lands late
      await h.settle();

      // The reopened tab shows ITS result, not the one nobody was waiting for.
      expect(h.frame()).toContain('total=42');
      expect(h.frame()).toContain('loading=false');
    } finally {
      h.unmount();
      restore();
    }
  });
});
