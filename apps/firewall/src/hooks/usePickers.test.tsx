// The identity picker's state. Its pure parts (filtering, validation, the busiest/quiet split)
// are tested elsewhere; this drives the hook that fetches and holds them, which is where a cache
// keyed by the wrong kind, or a load dropped as a duplicate, would actually show up.

import { afterEach, describe, expect, mock, test } from 'bun:test';

import { Text } from 'ink';
import { useEffect } from 'react';

import { renderInk } from '../ink-harness';
import { rollingWindow } from '../time-window';
import type { Pickers } from './usePickers';

const CREDS = { projectId: 'p', teamId: 't', token: 'k' };
const WINDOW = rollingWindow(24, new Date('2026-08-14T06:00:00.000Z'));
const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';

type Rows = [string, number][];
const IPS: Rows = [
  ['1.2.3.4', 900],
  ['5.6.7.8', 400],
];
const JA4S: Rows = [[DIGEST, 700]];

afterEach(() => {
  mock.restore();
});

/**
 * Mount the hook with the two top-list queries replaced.
 *
 * `calls` records which query ran, so a test can prove the cache was keyed by kind rather than
 * inferring it from the rows.
 */
async function mountPickers(
  opts: {
    ips?: () => Promise<{ rows: Rows; error?: string }>;
    ja4?: () => Promise<{ rows: Rows; error?: string }>;
    paneHeight?: number;
  } = {},
) {
  const calls: string[] = [];
  // Detached snapshot: mock.module mutates the live namespace in place, so a bare reference
  // would capture — and later "restore" — the stub installed just below.
  const real = { ...(await import('../ip-profile')) };
  mock.module('../ip-profile', () => ({
    ...real,
    topIps: async () => {
      calls.push('ip');
      return opts.ips ? opts.ips() : { rows: IPS };
    },
    topJa4: async () => {
      calls.push('ja4');
      return opts.ja4 ? opts.ja4() : { rows: JA4S };
    },
  }));
  const { usePickers } = await import('./usePickers');

  let api!: Pickers;
  function Probe() {
    const p = usePickers(opts.paneHeight ?? 40);
    useEffect(() => {
      api = p;
    });
    return (
      <Text>
        kind={p.kind} input={p.input || '-'} error={p.error || '-'} loading=
        {String(p.list.loading)} listErr={p.list.error || '-'} rows=
        {p.filtered.map(([id]) => id).join(',') || '-'} busiest=
        {p.busiest.length} pickable={p.pickable.length}
      </Text>
    );
  }
  const h = renderInk(<Probe />, { columns: 200 });
  await h.settle();
  return {
    h,
    get: () => api,
    calls,
    restore: () => mock.module('../ip-profile', () => ({ ...real })),
  };
}

describe('usePickers', () => {
  test('loading the IP list fills the rows', async () => {
    const t = await mountPickers();
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      expect(t.h.frame()).toContain('rows=1.2.3.4,5.6.7.8');
      expect(t.h.frame()).toContain('loading=false');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  // The two lists are separate caches. Keyed wrongly, `f` would show the IP list.
  test('the JA4 list is its own cache, not the IP one', async () => {
    const t = await mountPickers();
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      t.get().begin('ja4');
      t.get().load(CREDS, 'ja4', WINDOW);
      await t.h.settle();
      expect(t.h.frame()).toContain(`rows=${DIGEST}`);
      expect(t.calls).toEqual(['ip', 'ja4']);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('a second load of the same kind is served from cache', async () => {
    const t = await mountPickers();
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      expect(t.calls).toEqual(['ip']);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('force refetches, which is what a window change needs', async () => {
    const t = await mountPickers();
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      t.get().load(CREDS, 'ip', WINDOW, true);
      await t.h.settle();
      expect(t.calls).toEqual(['ip', 'ip']);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  // An upstream 504 must reach the pane, or the picker shows an empty list with no explanation.
  test('a failed query surfaces as the list error, not as an empty list', async () => {
    const t = await mountPickers({
      ips: async () => ({ rows: [], error: 'metrics 504: Query timed out' }),
    });
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      expect(t.h.frame()).toContain('listErr=metrics 504');
      expect(t.h.frame()).toContain('loading=false');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('begin resets the field for a fresh lookup', async () => {
    const t = await mountPickers();
    try {
      t.get().setInput('1.2');
      t.get().setError('not an IP address');
      t.get().setCursor(3);
      await t.h.settle();
      t.get().begin('ja4');
      await t.h.settle();
      expect(t.h.frame()).toContain('kind=ja4');
      expect(t.h.frame()).toContain('input=-');
      expect(t.h.frame()).toContain('error=-');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('typing filters the rows already loaded', async () => {
    const t = await mountPickers();
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      t.get().setInput('5.6');
      await t.h.settle();
      expect(t.h.frame()).toContain('rows=5.6.7.8');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('reset drops both caches so the next load refetches', async () => {
    const t = await mountPickers();
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      t.get().reset();
      await t.h.settle();
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      expect(t.calls).toEqual(['ip', 'ip']);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  describe('refreshLive', () => {
    test('refetches the visible kind and reports the outcome', async () => {
      const t = await mountPickers();
      try {
        expect(await t.get().refreshLive(CREDS, WINDOW)).toBe('ok');
        await t.h.settle();
        expect(t.calls).toEqual(['ip']);
      } finally {
        t.h.unmount();
        t.restore();
      }
    });

    // The backoff is driven by this return value, so a failure has to say so.
    test('a failure reports error, which is what drives the backoff', async () => {
      const t = await mountPickers({
        ips: async () => ({ rows: [], error: 'metrics 504' }),
      });
      try {
        expect(await t.get().refreshLive(CREDS, WINDOW)).toBe('error');
      } finally {
        t.h.unmount();
        t.restore();
      }
    });

    test('it follows the kind on screen', async () => {
      const t = await mountPickers();
      try {
        t.get().begin('ja4');
        await t.h.settle();
        await t.get().refreshLive(CREDS, WINDOW);
        expect(t.calls).toEqual(['ja4']);
      } finally {
        t.h.unmount();
        t.restore();
      }
    });

    // reset() used to run here, which blanked the rows for a tick even when the load was dropped.
    test('it does not blank the rows already on screen', async () => {
      const t = await mountPickers();
      try {
        t.get().load(CREDS, 'ip', WINDOW);
        await t.h.settle();
        await t.get().refreshLive(CREDS, WINDOW);
        await t.h.settle();
        expect(t.h.frame()).toContain('rows=1.2.3.4,5.6.7.8');
      } finally {
        t.h.unmount();
        t.restore();
      }
    });
  });

  test('a short pane still offers rows rather than none', async () => {
    // The busiest column is bounded by the viewport, and a floor of zero would show nothing.
    const t = await mountPickers({ paneHeight: 8 });
    try {
      t.get().load(CREDS, 'ip', WINDOW);
      await t.h.settle();
      expect(t.get().busiest.length).toBeGreaterThan(0);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });
});
