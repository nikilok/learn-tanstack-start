// The unattended loop: the path nobody is looking at when it runs, and the one with the most to
// lose. It had no tests at all — 452 lines whose whole contract is that silence means "nothing
// found", so any way it can go quiet without having looked is the defect that matters.
//
// Every module it reaches is stubbed, deliberately: a real tick screens production, spawns
// caffeinate, writes the watch log into the repo, and can invoke a paid investigation.

import { afterEach, describe, expect, mock, test } from 'bun:test';

import { Text } from 'ink';
import { useEffect } from 'react';

import { renderInk } from '../ink-harness';
import type { WatchlistEntry } from '../watchlist';
import type { Watch } from './useWatch';

const CREDS = { projectId: 'p', teamId: 't', token: 'k' };
const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';

type Finding = {
  digest: string;
  total: number;
  allowed: number;
  advice: { verdict: string; reasons: string[]; axes?: string[] };
};

const finding = (verdict: string, digest = DIGEST): Finding => ({
  digest,
  total: 900,
  allowed: 900,
  advice: { verdict, reasons: ['rendering'], axes: ['rendering', 'spread'] },
});

type Screen = {
  rows?: unknown[];
  findings?: Finding[];
  truncated?: boolean;
  configErrors?: string[];
};

afterEach(() => {
  mock.restore();
});

/** Mount useWatch with every side-effecting module replaced, and record what it tried to do. */
async function mountWatch(
  opts: {
    screen?: () => Promise<Screen> | Screen;
    investigate?: boolean;
    timing?: string | null;
  } = {},
) {
  const log: { kind: string; detail?: string }[] = [];
  const notified: string[] = [];
  const listed: WatchlistEntry[][] = [];
  let notifyFails = '';

  // Detached snapshots: mock.module mutates each live namespace in place, so a bare reference
  // would capture — and later "restore" — the stubs installed below.
  const realWatch = { ...(await import('../watch')) };
  mock.module('../watch', () => ({
    ...realWatch,
    screenOnce: async () => {
      const s = (await opts.screen?.()) ?? {};
      return {
        rows: s.rows ?? [{}],
        findings: s.findings ?? [],
        truncated: s.truncated ?? false,
        configErrors: s.configErrors ?? [],
      };
    },
    logShadow: async () => {},
    watchlistAdditions: () => [],
    adviceWhy: () => 'rendering',
  }));

  const realLog = { ...(await import('../watch-log')) };
  mock.module('../watch-log', () => ({
    ...realLog,
    logWatch: async (
      _d: string,
      _at: Date,
      e: { kind: string; error?: string },
    ) => {
      log.push({ kind: e.kind, detail: e.error });
    },
  }));

  const realTuning = { ...(await import('../tuning')) };
  mock.module('../tuning', () => ({
    ...realTuning,
    watchTiming: () =>
      opts.timing === undefined ? '24h window, every 5m' : opts.timing,
    watchHours: () => 24,
    watchIntervalMs: () => 300_000,
  }));

  const realMode = { ...(await import('../watch-mode')) };
  mock.module('../watch-mode', () => ({
    ...realMode,
    // False, or arming the loop spawns caffeinate against the real machine.
    canKeepAwake: () => false,
    recentSpawns: () => [],
    shouldInvestigate: () => Boolean(opts.investigate),
    fingerprintConfig: async () => 'same',
    investigationChangedConfig: () => false,
    runInvestigation: async () => ({
      ok: true,
      verdict: 'VERDICT: challenge\nshared digest',
      provenance: 'test',
    }),
    verdictFrom: () => 'challenge',
  }));

  const realNotify = { ...(await import('../watch-notify')) };
  mock.module('../watch-notify', () => ({
    ...realNotify,
    readInvestigated: async () => new Map<string, number>(),
    writeInvestigated: async () => {},
    shouldNotify: async () => true,
    rememberNotified: async () => {},
    concludedKey: (c: string[]) => c.join('|'),
    concludedText: (c: string[]) => c.join(' '),
    notify: async (text: string) => {
      notified.push(text);
      return notifyFails;
    },
  }));

  const realList = { ...(await import('../watchlist')) };
  mock.module('../watchlist', () => ({
    ...realList,
    recordAdditions: async () => ({ entries: [] as WatchlistEntry[] }),
  }));

  const { useWatch } = await import('./useWatch');

  let api!: Watch;
  function Probe() {
    const w = useWatch({
      creds: CREDS,
      onWatchlist: (e) => listed.push(e),
    });
    useEffect(() => {
      api = w;
    });
    return (
      <Text>
        on={String(w.on)} busy={String(w.busy)} note={w.note || '-'} who=
        {w.who.map((p) => `${p.verdict}:${p.total}`).join(',') || '-'} invoked=
        {w.invokedCount} verdict={w.verdictHead ? 'yes' : '-'}
      </Text>
    );
  }
  const h = renderInk(<Probe />, { columns: 220 });
  await h.settle();

  const restore = () => {
    mock.module('../watch', () => ({ ...realWatch }));
    mock.module('../watch-log', () => ({ ...realLog }));
    mock.module('../tuning', () => ({ ...realTuning }));
    mock.module('../watch-mode', () => ({ ...realMode }));
    mock.module('../watch-notify', () => ({ ...realNotify }));
    mock.module('../watchlist', () => ({ ...realList }));
  };
  return {
    h,
    get: () => api,
    log,
    notified,
    listed,
    restore,
    failNotify: (m: string) => {
      notifyFails = m;
    },
  };
}

/** Arm the loop and let its first tick — scheduled at zero — run to completion. */
async function arm(t: Awaited<ReturnType<typeof mountWatch>>) {
  t.get().toggle();
  await t.h.settle();
  await t.h.settle();
  await t.h.settle();
}

describe('useWatch', () => {
  test('starts disarmed and does nothing until it is toggled', async () => {
    const t = await mountWatch();
    try {
      expect(t.h.frame()).toContain('on=false');
      expect(t.log).toEqual([]);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('arming screens, and the screen is logged even when it finds nothing', async () => {
    // Logged either way, or the log cannot tell "ran and was quiet" from "never ran" — the first
    // thing you want to know of a background loop.
    const t = await mountWatch();
    try {
      await arm(t);
      expect(t.h.frame()).toContain('on=true');
      expect(t.log.map((l) => l.kind)).toContain('screen');
      expect(t.h.frame()).toContain('allowed through');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('it names what it profiled, with verdicts', async () => {
    const t = await mountWatch({
      screen: () => ({ findings: [finding('ban'), finding('watch', 'other')] }),
    });
    try {
      await arm(t);
      expect(t.h.frame()).toContain('ban:900');
      expect(t.h.frame()).toContain('watch:900');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  // A capped screen that surfaced nothing is BLIND, and rendering that as a quiet night is a
  // night the tool never actually had.
  test('a truncated screen with no rows says BLIND, not quiet', async () => {
    const t = await mountWatch({
      screen: () => ({ rows: [], truncated: true }),
    });
    try {
      await arm(t);
      expect(t.h.frame()).toContain('BLIND');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('a blind screen reaches the phone, not just the pane', async () => {
    const t = await mountWatch({
      screen: () => ({ rows: [], truncated: true }),
    });
    try {
      await arm(t);
      expect(t.notified.join(' ')).toContain('BLIND');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('config errors are logged and alarmed, not swallowed', async () => {
    const t = await mountWatch({
      screen: () => ({ configErrors: ['FW_ALLOWED_BOTS unreadable'] }),
    });
    try {
      await arm(t);
      expect(t.log.some((l) => l.kind === 'error')).toBe(true);
      expect(t.notified.join(' ')).toContain('FW_ALLOWED_BOTS');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  // A failed screen must not read as a quiet one: silence is the loop's way of saying "nothing
  // found", so silence has to be earned.
  test('a screen that throws is reported, and the loop stays armed', async () => {
    const t = await mountWatch({
      screen: () => {
        throw new Error('metrics 504');
      },
    });
    try {
      await arm(t);
      expect(t.h.frame()).toContain('watch failed');
      expect(t.h.frame()).toContain('on=true');
      expect(t.log.some((l) => l.kind === 'error')).toBe(true);
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('the busy flag clears after a tick, however it ended', async () => {
    const t = await mountWatch({
      screen: () => {
        throw new Error('metrics 504');
      },
    });
    try {
      await arm(t);
      expect(t.h.frame()).toContain('busy=false');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('unconfigured timing screens nothing and says which vars are missing', async () => {
    const t = await mountWatch({ timing: null });
    try {
      await arm(t);
      expect(t.h.frame()).toContain('FW_WATCH_HOURS');
      expect(t.log.map((l) => l.kind)).not.toContain('screen');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  describe('investigation', () => {
    test('a qualifying finding is invoked, logged and its verdict shown', async () => {
      const t = await mountWatch({
        screen: () => ({ findings: [finding('ban')] }),
        investigate: true,
      });
      try {
        await arm(t);
        expect(t.h.frame()).toContain('invoked=1');
        expect(t.h.frame()).toContain('verdict=yes');
        expect(t.log.map((l) => l.kind)).toContain('invoke');
        expect(t.log.map((l) => l.kind)).toContain('verdict');
      } finally {
        t.h.unmount();
        t.restore();
      }
    });

    test('its conclusion reaches the phone', async () => {
      const t = await mountWatch({
        screen: () => ({ findings: [finding('ban')] }),
        investigate: true,
      });
      try {
        await arm(t);
        expect(t.notified.join(' ')).toContain('challenge');
      } finally {
        t.h.unmount();
        t.restore();
      }
    });

    test('nothing qualifying means nothing invoked', async () => {
      const t = await mountWatch({
        screen: () => ({ findings: [finding('leave')] }),
        investigate: false,
      });
      try {
        await arm(t);
        expect(t.h.frame()).toContain('invoked=0');
        expect(t.log.map((l) => l.kind)).not.toContain('invoke');
      } finally {
        t.h.unmount();
        t.restore();
      }
    });
  });

  test('disarming logs it and stops reporting busy', async () => {
    const t = await mountWatch();
    try {
      await arm(t);
      t.get().toggle();
      await t.h.settle();
      expect(t.h.frame()).toContain('on=false');
      expect(t.log.map((l) => l.kind)).toContain('disarmed');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });

  test('arming is logged, so the log can say when the session began', async () => {
    const t = await mountWatch();
    try {
      await arm(t);
      expect(t.log.map((l) => l.kind)).toContain('armed');
    } finally {
      t.h.unmount();
      t.restore();
    }
  });
});
