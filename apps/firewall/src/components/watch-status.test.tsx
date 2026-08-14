// The panel an operator glances at while doing something else, so what it must never do is look
// the same whether the loop is working, idle, or reporting a conclusion nobody has read.

import { describe, expect, test } from 'bun:test';

import { Box, Text } from 'ink';

import type { Watch } from '../hooks/useWatch';
import { renderInk } from '../ink-harness';
import { WatchStatus, panelRows } from './watch-status';

const ARMED: Watch = {
  on: true,
  toggle: () => {},
  busy: false,
  at: '23:29',
  keepingAwake: true,
  note: '33 fingerprint(s) allowed through · 0 profiled · 0 would ban',
  who: [],
  invokedAt: '',
  invokedCount: 0,
  notifiedAt: '',
  verdictHead: '',
  verdictClipped: 0,
  verdictOf: '',
};

/** Render a panel and hand back its frame. */
async function frameOf(over: Partial<Watch> = {}) {
  const h = renderInk(<WatchStatus watch={{ ...ARMED, ...over }} />, {
    columns: 80,
  });
  await h.settle();
  const frame = h.frame();
  h.unmount();
  return frame;
}

describe('WatchStatus', () => {
  test('a disarmed loop renders nothing at all', async () => {
    expect((await frameOf({ on: false })).trim()).toBe('');
  });

  test('an armed loop reports its timing, last tick and what it screened', async () => {
    const frame = await frameOf();
    expect(frame).toContain('watch');
    expect(frame).toContain('23:29');
    expect(frame).toContain('33 fingerprint(s) allowed through');
  });

  // Boxed so it reads as its own panel rather than as more footer.
  test('it is drawn inside a border', async () => {
    const frame = await frameOf();
    expect(frame).toMatch(/[╭╰]/);
    expect(frame).toMatch(/[─│]/);
  });

  test('a tick that has not run yet says starting, not a stale time', async () => {
    expect(await frameOf({ at: '' })).toContain('starting');
  });

  test('holding the machine awake is stated, because it is a thing being done to the mac', async () => {
    expect(await frameOf()).toContain('holding the mac awake');
    expect(await frameOf({ keepingAwake: false })).not.toContain(
      'holding the mac awake',
    );
  });

  // Named, or "1 profiled" sends the operator digging through the log.
  describe('the identities a tick profiled', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        digest: `t13d1516h2_8daaf6152771_${String(i).padStart(12, 'a')}`,
        total: 900 - i * 100,
        verdict: i === 0 ? 'ban' : 'watch',
        why: 'rendering, spread',
      }));

    test('each one is named, with its verdict and volume', async () => {
      // note cleared: the default one says "0 would ban", so these assertions could be satisfied
      // by the header while ProfiledRow rendered nothing at all.
      const frame = await frameOf({ note: '', who: many(2) });
      expect(frame).toContain('ban');
      expect(frame).toContain('watch');
      expect(frame).toContain('900 req');
      expect(frame).toContain('800 req');
    });

    // The row is ~38 columns and a digest alone is 37, so ordering decides what survives
    // truncation. Verdict-last meant the verdict never appeared at all.
    test('the verdict survives at the real panel width', async () => {
      const h = renderInk(
        <WatchStatus watch={{ ...ARMED, note: '', who: many(1) }} />,
        { columns: 44 },
      );
      await h.settle();
      expect(h.frame()).toContain('ban');
      h.unmount();
    });

    // These digests share a profile prefix, so a head-only truncation renders identical rows.
    test('two digests off one TLS build are still told apart', async () => {
      const frame = await frameOf({ who: many(2) });
      expect(frame).toContain('aaaaaaa0');
      expect(frame).toContain('aaaaaaa1');
    });

    // A busy tick would otherwise grow the panel until it pushes the rule list off screen.
    test('a long list is capped, and says how many it withheld', async () => {
      const frame = await frameOf({ who: many(9) });
      expect(frame).toContain('… 3 more');
      expect(frame).toContain('watch list');
    });

    test('a list at the cap says nothing about withholding', async () => {
      expect(await frameOf({ who: many(6) })).not.toContain('more · t');
    });
  });

  test('an invocation stays on screen once it has happened', async () => {
    // The loop runs while you are in another pane, so one you did not watch must still be visible.
    const frame = await frameOf({ invokedCount: 2, invokedAt: '23:31' });
    expect(frame).toContain('claude invoked');
    expect(frame).toContain('2×');
    expect(frame).toContain('23:31');
  });

  test('with no invocation it says where the log is instead', async () => {
    const frame = await frameOf();
    expect(frame).toContain('logging to');
    expect(frame).not.toContain('claude invoked');
  });

  test('a verdict is shown under the identity it belongs to', async () => {
    // Without the identity the pane renders the PREVIOUS conclusion under a generic heading while
    // a new investigation runs, and an operator acting on it acts on the wrong fingerprint.
    const frame = await frameOf({
      verdictHead: 'VERDICT: challenge\nshared digest, zero rendering',
      verdictOf: 't13d1516h2_8daaf6152771_b0da82dd1658',
    });
    expect(frame).toContain('investigation');
    expect(frame).toContain('t13d1516h2_8daaf6152771_b0da82dd1658');
    expect(frame).toContain('VERDICT: challenge');
  });

  test('a clipped verdict says how much is missing and where the rest is', async () => {
    // A clipped verdict that does not say so reads as complete, which is worse than none.
    const frame = await frameOf({
      verdictHead: 'VERDICT: ban',
      verdictClipped: 7,
      verdictOf: 'abc',
    });
    expect(frame).toContain('7 more line(s)');
    expect(frame).toContain('firewall-watch.log');
  });
});

// Measured before this existed: an armed panel with six profiles and a verdict came to 26 rows,
// against an app frame that already filled a 24-row terminal. Bounded is not the same as fits.
/** Verdict costs when nothing wraps: one row per line. */
const oneRow = (n: number) => Array.from({ length: n }, () => 1);
/** Fixed rows when nothing wraps: the box's four, plus header, note and status at one each. */
const FIXED = 7;

describe('panelRows', () => {
  test('a generous budget gives both lists everything they asked for', () => {
    expect(panelRows(40, 6, oneRow(12), FIXED)).toEqual({
      profiles: 6,
      verdict: 12,
      overflow: false,
    });
  });

  test('a tight budget sheds the verdict first — it says where its full text is', () => {
    const room = panelRows(14, 6, oneRow(12), FIXED);
    expect(room.profiles).toBe(6);
    expect(room.verdict).toBeLessThan(12);
  });

  test('a budget with no room at all shows neither, and never a negative count', () => {
    const room = panelRows(5, 6, oneRow(12), FIXED);
    expect(room.profiles).toBe(0);
    expect(room.verdict).toBe(0);
  });

  test('the panel never exceeds the budget it was given, at any width', async () => {
    const who = Array.from({ length: 9 }, (_, i) => ({
      digest: `t13d17${i}4h1_5b57614c22b0_7baf387fc6ff`,
      total: 900,
      verdict: 'watch',
      why: 'rendering',
    }));
    // The loop's real note and a real verdict, both long enough to wrap at a narrow width.
    const note = '33 fingerprint(s) allowed through · 1 profiled · 0 would ban';
    const verdictHead = Array.from(
      { length: 12 },
      (_, i) => `line ${i} of a verdict long enough to wrap in a narrow column`,
    ).join('\n');
    // Widths as well as budgets. Every earlier version of this swept budgets at 140 columns,
    // where nothing wraps — so it could not see the case that was actually overflowing.
    // Measured by where a SIBLING lands: counting the panel's own lines hid its margins twice.
    for (const width of [140, 44, 38]) {
      for (let maxRows = 7; maxRows <= 24; maxRows++) {
        const h = renderInk(
          <Box flexDirection="column" width={width}>
            <WatchStatus
              watch={{
                ...ARMED,
                note,
                who,
                verdictHead,
                verdictOf: 'x',
                invokedCount: 1,
              }}
              maxRows={maxRows}
              width={width}
            />
            <Text>ZZMARKERZZ</Text>
          </Box>,
          { columns: width + 4 },
        );
        await h.settle();
        const occupied = h
          .frame()
          .split('\n')
          .findIndex((l) => l.includes('ZZMARKERZZ'));
        h.unmount();
        expect(occupied).toBeGreaterThan(0);
        expect({ width, maxRows, occupied }).toEqual({
          width,
          maxRows,
          occupied: Math.min(occupied, maxRows),
        });
      }
    }
  }, 30_000);

  // The clipped row shows whenever ANYTHING is missing, including lines useWatch dropped before
  // the panel saw them. Reserved only when the panel itself did the dropping, that row still
  // rendered on a verdict that fit — one past the budget, on the case with the least slack.
  test('a verdict that fits but was already clipped upstream still reserves its row', async () => {
    for (const width of [140, 44]) {
      for (let maxRows = 12; maxRows <= 20; maxRows++) {
        const h = renderInk(
          <Box flexDirection="column" width={width}>
            <WatchStatus
              watch={{
                ...ARMED,
                verdictHead: 'one\ntwo',
                verdictClipped: 40,
                verdictOf: 'x',
              }}
              maxRows={maxRows}
              width={width}
            />
            <Text>ZZMARKERZZ</Text>
          </Box>,
          { columns: width + 4 },
        );
        await h.settle();
        const occupied = h
          .frame()
          .split('\n')
          .findIndex((l) => l.includes('ZZMARKERZZ'));
        h.unmount();
        expect({ width, maxRows, occupied }).toEqual({
          width,
          maxRows,
          occupied: Math.min(occupied, maxRows),
        });
      }
    }
  }, 30_000);

  test('a clipped verdict counts what the LAYOUT dropped too, not just useWatch', async () => {
    const h = renderInk(
      <WatchStatus
        watch={{
          ...ARMED,
          verdictHead: Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'),
          verdictClipped: 3,
          verdictOf: 'x',
        }}
        maxRows={12}
      />,
      { columns: 140 },
    );
    await h.settle();
    const frame = h.frame();
    h.unmount();
    // 3 already dropped, plus whatever did not fit — never just the 3.
    expect(frame).toMatch(/… (?!3 more line)\d+ more line/);
  });
});

describe('WatchStatus floor', () => {
  // Below its own chrome the panel cannot shrink further, so the caller must not ask. app.tsx
  // floors the budget at exactly this. Asserted so a change to CHROME that breaks the pairing
  // fails here rather than by overflowing a terminal.
  test('a budget under the chrome yields no rows for either list', () => {
    // overflow false as well: with no room there is no row to spend saying rows are hidden,
    // and drawing it anyway is what put the panel over its budget at the floor.
    const floor = { profiles: 0, verdict: 0, overflow: false };
    expect(panelRows(7, 9, oneRow(12), FIXED)).toEqual(floor);
    expect(panelRows(0, 9, oneRow(12), FIXED)).toEqual(floor);
  });
});
