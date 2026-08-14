// The panel an operator glances at while doing something else, so what it must never do is look
// the same whether the loop is working, idle, or reporting a conclusion nobody has read.

import { describe, expect, test } from 'bun:test';

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
describe('panelRows', () => {
  test('a generous budget gives both lists everything they asked for', () => {
    expect(panelRows(40, 6, 12)).toEqual({ profiles: 6, verdict: 12 });
  });

  test('a tight budget sheds the verdict first — it says where its full text is', () => {
    const room = panelRows(14, 6, 12);
    expect(room.profiles).toBe(6);
    expect(room.verdict).toBeLessThan(12);
  });

  test('a budget with no room at all shows neither, and never a negative count', () => {
    const room = panelRows(5, 6, 12);
    expect(room.profiles).toBe(0);
    expect(room.verdict).toBe(0);
  });

  test('the panel never exceeds the budget it was given', async () => {
    const who = Array.from({ length: 9 }, (_, i) => ({
      digest: `t13d17${i}4h1_5b57614c22b0_7baf387fc6ff`,
      total: 900,
      verdict: 'watch',
      why: 'rendering',
    }));
    const verdictHead = Array.from({ length: 12 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    // From CHROME upward: the panel cannot render in fewer rows than its own frame costs, and
    // app.tsx floors the budget at that same number.
    for (let maxRows = 7; maxRows <= 30; maxRows++) {
      const h = renderInk(
        <WatchStatus
          watch={{ ...ARMED, who, verdictHead, verdictOf: 'x', invokedCount: 1 }}
          maxRows={maxRows}
        />,
        { columns: 140 },
      );
      await h.settle();
      // EVERY line, blanks included: the panel's own margins are blank rows that occupy the
      // column exactly like text does, and filtering them out is what hid two of them.
      const lines = h.frame().replace(/\n+$/, '').split('\n').length;
      h.unmount();
      expect(lines).toBeLessThanOrEqual(maxRows);
    }
  });

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
    expect(panelRows(7, 9, 12)).toEqual({ profiles: 0, verdict: 0 });
    expect(panelRows(0, 9, 12)).toEqual({ profiles: 0, verdict: 0 });
  });
});
