// The side-pane keybindings as ONE table.
//
// The handler and the footer hints are generated from the same entries, so a key that works cannot
// go unadvertised and a hint cannot describe a key that does nothing. Those were two hand-written
// lists, and on 2026-08-12 they disagreed: `b` worked while its hint was hidden.

import type { Hint } from './components/footer-hints';

/** Every side pane, in the order the footer walks them. Derived from, never restated — a second list is one that can disagree. */
export const PANE_KINDS = [
  'report',
  'ip',
  'sitemap',
  'denylist',
  'watchlist',
  'ignorelist',
] as const;

export type PaneKind = (typeof PANE_KINDS)[number];

/** A keypress reduced to what a binding matches on. */
export type Press = {
  input: string;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};

export type Binding = {
  /** What the footer calls the key: 'u', 'enter', 'j/k'. */
  key: string;
  /** What the footer says it does. */
  label: string;
  /** Panes it is live in. Omitted means every pane. */
  panes?: readonly PaneKind[];
  /** Further condition. Governs the handler AND the hint together, which is the whole point. */
  when?: boolean;
  /** Drawn highlighted — for a toggle that is currently on. */
  active?: boolean;
  /** Deliberately absent from the footer: shown elsewhere on screen, or not worth a slot. */
  unlisted?: boolean;
  matches: (p: Press) => boolean;
  run: (p: Press) => void;
};

/** Matchers, so a binding names the key rather than re-deriving it from the Press shape. */
export const press = {
  char:
    (...chars: string[]) =>
    (p: Press) =>
      Boolean(p.input) && chars.includes(p.input),
  enter: (p: Press) => Boolean(p.return),
  escape: (p: Press) => Boolean(p.escape),
  tab: (p: Press) => Boolean(p.tab),
  up: (p: Press) => Boolean(p.upArrow) || p.input === 'k',
  down: (p: Press) => Boolean(p.downArrow) || p.input === 'j',
  pageUp: (p: Press) => Boolean(p.pageUp),
  pageDown: (p: Press) => Boolean(p.pageDown),
};

/** Up or down, for a binding that handles both under one hint. */
export const isUp = press.up;

/** The bindings live in `pane` right now, in table order. */
export function liveBindings(
  table: readonly Binding[],
  pane: PaneKind,
): Binding[] {
  return table.filter(
    (b) => (!b.panes || b.panes.includes(pane)) && b.when !== false,
  );
}

// First match wins, so table order IS precedence — a pane-specific binding must sit above the
// general one it would otherwise be shadowed by.
/** The binding a press triggers, if any. */
export function bindingFor(
  table: readonly Binding[],
  pane: PaneKind,
  p: Press,
): Binding | undefined {
  return liveBindings(table, pane).find((b) => b.matches(p));
}

/** Footer hints for exactly the bindings that are live and listed. */
export function hintsFor(table: readonly Binding[], pane: PaneKind): Hint[] {
  return liveBindings(table, pane)
    .filter((b) => !b.unlisted)
    .map((b) => ({ key: b.key, label: b.label, active: b.active }));
}
