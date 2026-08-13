// The handler and the footer were two hand-written lists that had to agree, and on 2026-08-12
// they did not: `b` worked while its hint was hidden. These tests lock the property that makes
// that impossible — one table, filtered the same way for both.

import { describe, expect, test } from 'bun:test';

import {
  type Binding,
  PANE_KINDS,
  type Press,
  bindingFor,
  hintsFor,
  isUp,
  liveBindings,
  press,
} from './pane-keys';

const PANES = PANE_KINDS;

const key = (input: string): Press => ({ input });
const special = (k: Partial<Press>): Press => ({ input: '', ...k });

/** A binding that records whether it ran. */
function bind(over: Partial<Binding> & { key: string }): Binding & {
  ran: () => number;
} {
  let count = 0;
  const b: Binding = {
    label: over.key,
    matches: press.char(over.key),
    run: () => {
      count += 1;
    },
    ...over,
  };
  return Object.assign(b, { ran: () => count });
}

describe('liveBindings', () => {
  test('an unscoped binding is live in every pane', () => {
    const table = [bind({ key: 'R' })];
    for (const pane of PANES) expect(liveBindings(table, pane)).toHaveLength(1);
  });

  test('a scoped binding is live only in its panes', () => {
    const table = [bind({ key: 'u', panes: ['denylist'] })];
    expect(liveBindings(table, 'denylist')).toHaveLength(1);
    expect(liveBindings(table, 'ip')).toHaveLength(0);
  });

  test('`when: false` takes a binding out entirely', () => {
    const table = [bind({ key: 'x', when: false })];
    expect(liveBindings(table, 'ip')).toHaveLength(0);
  });

  test('an omitted `when` is live, so a binding is not silently disabled by default', () => {
    expect(liveBindings([bind({ key: 'x' })], 'ip')).toHaveLength(1);
  });

  test('table order is preserved, because it is precedence', () => {
    const table = [bind({ key: 'a' }), bind({ key: 'b' }), bind({ key: 'c' })];
    expect(liveBindings(table, 'ip').map((b) => b.key)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('bindingFor', () => {
  test('runs the binding whose key was pressed', () => {
    const u = bind({ key: 'u', panes: ['denylist'] });
    bindingFor([u], 'denylist', key('u'))?.run(key('u'));
    expect(u.ran()).toBe(1);
  });

  test('a key with no binding in this pane does nothing', () => {
    const u = bind({ key: 'u', panes: ['denylist'] });
    expect(bindingFor([u], 'ip', key('u'))).toBeUndefined();
  });

  // Table order IS precedence: a pane-specific binding must win over the general one below it.
  test('the first match wins', () => {
    const specific = bind({ key: 'x', panes: ['watchlist'] });
    const general = bind({ key: 'x' });
    const hit = bindingFor([specific, general], 'watchlist', key('x'));
    hit?.run(key('x'));
    expect(specific.ran()).toBe(1);
    expect(general.ran()).toBe(0);
  });

  test('a disabled binding does not shadow the one beneath it', () => {
    const off = bind({ key: 'x', when: false });
    const on = bind({ key: 'x' });
    bindingFor([off, on], 'ip', key('x'))?.run(key('x'));
    expect(on.ran()).toBe(1);
  });

  // The live hazard in app.tsx's table: `esc` is unscoped. If a pane-scoped esc is ever added
  // BELOW it, it is unreachable — and nothing about the table's shape says so.
  test('an unscoped binding placed above a scoped one shadows it', () => {
    const fallback = bind({ key: 'esc', matches: press.escape });
    const scoped = bind({
      key: 'esc',
      panes: ['denylist'],
      matches: press.escape,
    });
    bindingFor([fallback, scoped], 'denylist', special({ escape: true }))?.run(
      special({ escape: true }),
    );
    expect(fallback.ran()).toBe(1);
    expect(scoped.ran()).toBe(0);
  });

  test('the same pair in the other order reaches the scoped one', () => {
    const scoped = bind({
      key: 'esc',
      panes: ['denylist'],
      matches: press.escape,
    });
    const fallback = bind({ key: 'esc', matches: press.escape });
    bindingFor([scoped, fallback], 'denylist', special({ escape: true }))?.run(
      special({ escape: true }),
    );
    expect(scoped.ran()).toBe(1);
    expect(fallback.ran()).toBe(0);
  });

  test('an empty input never matches a character binding', () => {
    // Arrow keys arrive with input '', and `includes('')` would otherwise fire every binding.
    expect(bindingFor([bind({ key: 'q' })], 'ip', special({}))).toBeUndefined();
  });
});

describe('press matchers', () => {
  test('j and k stand in for the arrows', () => {
    expect(press.up(key('k'))).toBe(true);
    expect(press.down(key('j'))).toBe(true);
    expect(press.up(special({ upArrow: true }))).toBe(true);
    expect(press.down(special({ downArrow: true }))).toBe(true);
  });

  test('up and down are distinguishable by a binding that handles both', () => {
    expect(isUp(key('k'))).toBe(true);
    expect(isUp(key('j'))).toBe(false);
  });

  test('enter, escape and tab match their own keys only', () => {
    expect(press.enter(special({ return: true }))).toBe(true);
    expect(press.enter(key('m'))).toBe(false);
    expect(press.escape(special({ escape: true }))).toBe(true);
    expect(press.tab(special({ tab: true }))).toBe(true);
  });

  test('page up and page down match their own keys only', () => {
    expect(press.pageUp(special({ pageUp: true }))).toBe(true);
    expect(press.pageUp(special({ pageDown: true }))).toBe(false);
    expect(press.pageDown(special({ pageDown: true }))).toBe(true);
    expect(press.pageDown(special({ pageUp: true }))).toBe(false);
  });

  test('a binding can accept several characters, for an upper-case alias', () => {
    const m = press.char('v', 'V');
    expect(m(key('v'))).toBe(true);
    expect(m(key('V'))).toBe(true);
    expect(m(key('b'))).toBe(false);
  });
});

// The whole point of the table.
describe('hintsFor', () => {
  test('every live binding is advertised', () => {
    const table = [
      bind({ key: 'b', panes: ['ip'], label: 'deny fingerprint' }),
      bind({ key: 'u', panes: ['denylist'] }),
    ];
    expect(hintsFor(table, 'ip')).toEqual([
      { key: 'b', label: 'deny fingerprint', active: undefined },
    ]);
  });

  test('a binding that is not live is not advertised either', () => {
    // The two must move together — a hint for a dead key is as wrong as a hidden live one.
    const table = [bind({ key: 'x', panes: ['ip'], when: false })];
    expect(hintsFor(table, 'ip')).toEqual([]);
  });

  test('only an explicitly unlisted binding is hidden while live', () => {
    const table = [bind({ key: 'q', unlisted: true }), bind({ key: 'R' })];
    expect(hintsFor(table, 'ip').map((h) => h && h.key)).toEqual(['R']);
    expect(bindingFor(table, 'ip', key('q'))).toBeDefined();
  });

  test('a toggle carries its active state into the footer', () => {
    const table = [bind({ key: 'v', label: 'watch (on)', active: true })];
    expect(hintsFor(table, 'ip')[0]).toEqual({
      key: 'v',
      label: 'watch (on)',
      active: true,
    });
  });

  // The invariant, stated directly: anything reachable is either advertised or deliberately not.
  test('for every pane, each live binding is hinted or explicitly unlisted', () => {
    const table = [
      bind({ key: 'R' }),
      bind({ key: 'b', panes: ['ip'] }),
      bind({ key: 'u', panes: ['denylist'] }),
      bind({ key: 'q', unlisted: true }),
      bind({ key: 'x', panes: ['ip'], when: false }),
    ];
    for (const pane of PANES) {
      const hinted = new Set(hintsFor(table, pane).map((h) => h && h.key));
      for (const b of liveBindings(table, pane))
        expect(b.unlisted === true || hinted.has(b.key)).toBe(true);
    }
  });

  test('and every hint corresponds to a key that actually resolves', () => {
    const table = [
      bind({ key: 'R' }),
      bind({ key: 'b', panes: ['ip'] }),
      bind({ key: 'u', panes: ['denylist'] }),
    ];
    for (const pane of PANES)
      for (const hint of hintsFor(table, pane))
        if (hint) expect(bindingFor(table, pane, key(hint.key))).toBeDefined();
  });
});
