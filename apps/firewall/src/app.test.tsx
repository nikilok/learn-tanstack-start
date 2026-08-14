// Mounts the real TUI. Unit tests cover each extracted module; this covers the wiring between
// them, which is the half a refactor breaks and a pure test cannot see.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReactNode } from 'react';

import { KEY, renderInk } from './ink-harness';
import { TEST_DENIED_JA4 } from './test-setup';
import { IGNORELIST_FILE, WATCHLIST_FILE } from './watchlist';

// Every value the rule set is seeded from is set by the preload, before any module reads it.
const DIGEST = TEST_DENIED_JA4;

let App: () => ReactNode;

beforeAll(async () => {
  const { mock } = await import('bun:test');
  // Wholly synthetic, and it deliberately never imports the real ./client. That module resolves
  // credentials at import time, and watch-assembly's offline test makes an import of it throw —
  // which is permanent, so any later import gets a TDZ error instead of a fresh evaluation.
  const { noLiveConfig } = await import('./seed-items');
  // Stubbed too: opening the report pane calls fetchReport, which would put a live observability
  // request on the wire from the suite. The tests below only need the pane to open.
  mock.module('./report-data', () => ({
    fetchReport: async () => {
      throw new Error('report stubbed in tests');
    },
  }));
  mock.module('./client', () => ({
    projectId: 'prj_test',
    teamId: 'team_test',
    token: 'test-token',
    fetchLive: async () => noLiveConfig(),
    applyItem: async () => ({ status: 'overwrote' as const }),
  }));
  ({ App } = await import('./app'));
});

afterAll(() => {
  // The fatal path sets this, and a leaked non-zero code fails the whole run.
  process.exitCode = 0;
});

/** Mount and wait past the initial config load. */
async function mountApp() {
  const h = renderInk(<App />, { columns: 140, rows: 40 });
  await h.settle();
  await h.settle();
  return h;
}

describe('App', () => {
  test('loads the config and lists the rules rather than staying on the spinner', async () => {
    const h = await mountApp();
    expect(h.frame()).toContain('Vercel firewall rules');
    expect(h.frame()).toContain('deny-scraper-ja4');
    expect(h.frame()).not.toContain('Loading firewall config');
    h.unmount();
  });

  test('the dry-run banner is shown, so an operator cannot mistake it for live', async () => {
    const h = await mountApp();
    expect(h.frame()).toContain('DRY-RUN');
    h.unmount();
  });

  test('d opens the bans pane and lists what is live', async () => {
    const h = await mountApp();
    await h.press('d');
    expect(h.frame()).toContain(DIGEST);
    expect(h.frame()).toContain('live');
    h.unmount();
  });

  test('esc returns from a pane to the rules editor', async () => {
    const h = await mountApp();
    await h.press('d');
    await h.press(KEY.escape);
    expect(h.frame()).toContain('apply');
    h.unmount();
  });

  // The extraction's real risk: unstage, the entry list, the pending marker and the confirm
  // dialog were four separate pieces of App and are now three modules plus a hook.
  test('u lifts a deny through the confirm dialog and marks the rule unapplied', async () => {
    const h = await mountApp();
    await h.press('d');
    await h.press('u');
    expect(h.frame()).toContain('Lift the deny on');
    expect(h.frame()).toContain(DIGEST);

    await h.press('y');
    expect(h.frame()).toContain('UNBANNED');
    // The rules list has to say the rule now carries an unapplied edit.
    expect(h.frame()).toContain('rule(s) unapplied');
    h.unmount();
  });

  test('n cancels the lift, leaving the deny live', async () => {
    const h = await mountApp();
    await h.press('d');
    await h.press('u');
    await h.press('n');
    expect(h.frame()).not.toContain('UNBANNED');
    expect(h.frame()).not.toContain('rule(s) unapplied');
    h.unmount();
  });

  test('esc cancels the lift too', async () => {
    const h = await mountApp();
    await h.press('d');
    await h.press('u');
    await h.press(KEY.escape);
    expect(h.frame()).not.toContain('UNBANNED');
    h.unmount();
  });

  test('the footer advertises the pane keys that work there', async () => {
    const h = await mountApp();
    await h.press('d');
    const frame = h.frame();
    for (const hint of ['unban', 'copy', 'refresh'])
      expect(frame).toContain(hint);
    h.unmount();
  });

  test('t and g open the watch and ignore panes', async () => {
    // Neither file exists under the test cwd, so both are legitimately empty — the point is that
    // the key reaches the right pane and the pane renders rather than throwing.
    const h = await mountApp();
    await h.press('t');
    expect(h.frame()).toContain('watch');
    await h.press('g');
    expect(h.frame()).toContain('ignore');
    h.unmount();
  });

  test('the two list panes advertise different keys', async () => {
    // The watch list can be ignored (z); the ignore list can be watched (m). Swapping them was
    // possible while both handlers read from hand-written parallel state.
    const h = await mountApp();
    await h.press('t');
    expect(h.frame()).toContain('ignore');
    await h.press('g');
    expect(h.frame()).toContain('watch it');
    h.unmount();
  });

  // The 2026-08-12 regression: `b` worked while its hint was hidden, because the handler and the
  // footer were two hand-written lists. Both now come from one table.
  test('a key the pane does not bind is inert, with no fallthrough', () =>
    mountApp().then(async (h) => {
      // `u` is the bans pane's unban. On the report pane nothing claims it, and the table has no
      // catch-all beneath, so the frame must not change at all.
      await h.press('r');
      const before = h.frame();
      await h.press('u');
      expect(h.frame()).toBe(before);
      h.unmount();
    }));

  test('each pane footer only advertises keys that pane actually binds', async () => {
    // `unban` belongs to the bans pane and `watch it` to the ignore pane; neither may leak into
    // the other, which is what a second hand-written list used to allow.
    const h = await mountApp();
    await h.press('d');
    const bans = h.frame();
    expect(bans).toContain('unban');
    expect(bans).not.toContain('watch it');
    expect(bans).not.toContain('close tab');

    await h.press('g');
    const ignore = h.frame();
    expect(ignore).toContain('watch it');
    expect(ignore).not.toContain('unban');
    h.unmount();
  });

  test('the list panes say select, and the scrolling panes say scroll', async () => {
    // The sitemap pane moved a cursor while its hint said "scroll" — the label came from a
    // hand-written list that did not know which keys the handler had bound.
    const h = await mountApp();
    await h.press('d');
    expect(h.frame()).toContain('j/k select');
    await h.press('r');
    expect(h.frame()).toContain('j/k scroll');
    h.unmount();
  });

  // Every remove is confirmed, on both list panes and the bans pane. A drop you did not mean is
  // silent, and Ctrl-X reached these keys before the modifier guard landed.
  describe('removes are guarded', () => {
    // The pane reads process.cwd(), so the row has to exist on disk for `x` to have anything to
    // act on. Without a real row the test passes whether or not the guard is there at all.
    const WATCHED = 't13d1516h2_8daaf6152771_aaaabbbbcccc';
    const listFile = join(process.cwd(), WATCHLIST_FILE);
    const seedList = () =>
      writeFileSync(
        listFile,
        `ja4|${WATCHED}|2026-08-14T06:00:00.000Z|2026-08-14T06:00:00.000Z|1|manual|seeded\n`,
      );
    const dropList = () => {
      try {
        unlinkSync(listFile);
      } catch {
        // already gone
      }
    };

    test('x on the watch list asks before removing', async () => {
      seedList();
      const h = await mountApp();
      try {
        await h.press('t');
        expect(h.frame()).toContain('seeded');
        await h.press('x');
        expect(h.frame()).toContain('Remove');
        expect(h.frame()).toContain(WATCHED);
        // Still listed: nothing happens until the prompt is answered.
        await h.press('n');
        expect(h.frame()).toContain('seeded');
      } finally {
        h.unmount();
        dropList();
      }
    });

    test('answering y actually removes it', async () => {
      seedList();
      const h = await mountApp();
      try {
        await h.press('t');
        await h.press('x');
        await h.press('y');
        await h.settle();
        expect(h.frame()).not.toContain('seeded');
      } finally {
        h.unmount();
        dropList();
      }
    });

    test('x on the ignore list asks too', async () => {
      // Un-ignoring is not harmless either: it puts an identity back in front of the screen that
      // somebody deliberately muted.
      const ignoreFile = join(process.cwd(), IGNORELIST_FILE);
      writeFileSync(
        ignoreFile,
        `ja4|${WATCHED}|2026-08-14T06:00:00.000Z|2026-08-14T06:00:00.000Z|1|manual|muted\n`,
      );
      const h = await mountApp();
      try {
        await h.press('g');
        expect(h.frame()).toContain('muted');
        await h.press('x');
        expect(h.frame()).toContain('Remove');
        await h.press('n');
        expect(h.frame()).toContain('muted');
      } finally {
        h.unmount();
        try {
          unlinkSync(ignoreFile);
        } catch {
          // already gone
        }
      }
    });

    test('x on an empty list prompts nothing', async () => {
      dropList();
      const h = await mountApp();
      await h.press('t');
      await h.press('x');
      expect(h.frame()).not.toContain('Remove');
      h.unmount();
    });

    test('the bans pane asks before lifting, and n cancels', async () => {
      const h = await mountApp();
      await h.press('d');
      await h.press('u');
      expect(h.frame()).toContain('Lift the deny on');
      await h.press('n');
      expect(h.frame()).not.toContain('UNBANNED');
      h.unmount();
    });
  });

  test('i opens the IP picker and takes typed input', async () => {
    const h = await mountApp();
    await h.press('i');
    await h.press('1.2.3.4');
    expect(h.frame()).toContain('1.2.3.4');
    h.unmount();
  });

  // The endpoint intermittently answers 504 Query timed out. The spinner used to vanish after
  // ~90s of retries leaving an empty pane and no message, which reads as a broken tool.
  test('a failed identity list says so, and says how to retry', async () => {
    const { mock } = await import('bun:test');
    const real = await import('./ip-profile');
    mock.module('./ip-profile', () => ({
      ...real,
      topJa4: async () => ({
        rows: [],
        error: 'metrics 504: {"error":{"code":"TIMEOUT"}}',
      }),
    }));
    const fresh = await import('./app');
    const h = renderInk(<fresh.App />, { columns: 140, rows: 40 });
    try {
      await h.settle();
      await h.settle();
      await h.press('f');
      await h.settle();

      const frame = h.frame();
      expect(frame).toContain('fingerprint list failed');
      expect(frame).toContain('504');
      expect(frame).toContain('esc then f retries');
      expect(frame).not.toContain('loading busiest');
    } finally {
      // In a finally: a failed assertion would otherwise leave the app mounted and ./ip-profile
      // mocked for every test after it.
      h.unmount();
      mock.module('./ip-profile', () => real);
    }
  });

  test('the picker refuses a value that is not an address', async () => {
    const h = await mountApp();
    await h.press('i');
    await h.press(KEY.enter);
    expect(h.frame()).toContain('not an IP address');
    h.unmount();
  });

  test('w offers the timeline presets from the picker', async () => {
    const h = await mountApp();
    await h.press('i');
    await h.press('w');
    expect(h.frame()).toContain('timeline');
    expect(h.frame()).toContain('custom');
    h.unmount();
  });
});
