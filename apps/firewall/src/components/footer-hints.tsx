// The footer key/label bar, one definition so every footer in the TUI reads the same way:
// the key you press in bold, a colon, then what it does dimmed beside it.
//
// The segment mapping and the wrapped-row count are pure and tested; the Ink wrapper is a thin
// render of them. A hint may be false/null so a caller can inline conditional keys with
// `cond && { key, label }` and filter.

import { Text } from 'ink';

export type Hint = { key: string; label: string; active?: boolean };
export type MaybeHint = Hint | false | null | undefined;

/** key = the accent, active = the live-toggle green, dim = labels and separators. */
export type HintTone = 'key' | 'active' | 'dim';
export type HintSeg = { text: string; tone: HintTone };

// Only the live-toggle gets a colour. A key is BOLD and otherwise the terminal's own foreground,
// which is what makes it read as bright against the dimmed label without assuming a dark theme —
// a hard-coded white would vanish on a light one.
const TONE_COLOUR: Record<'active', string> = { active: 'green' };

// A hint is one unbreakable unit when wrapped, so its own spaces are non-breaking and only the
// separators between hints break — otherwise `w timeline` splits with the key stranded a line up.
const NBSP = ' ';
const nbsp = (s: string) => s.replace(/ /g, NBSP);
const SEP = ' │ ';
// Binds the key to its label tighter than a space does, so the pairs read as units across a long
// row and the eye can skip the labels entirely when hunting for a key.
const JOIN = ':';

/** The width one hint occupies: key, the joining colon, and its label. */
function hintWidth(h: Hint): number {
  return h.key.length + JOIN.length + h.label.length;
}

/** Flatten hints to coloured segments: `key:label │ key:label`, separators and labels dim. */
export function hintSegments(hints: readonly MaybeHint[]): HintSeg[] {
  const shown = hints.filter((h): h is Hint => Boolean(h));
  const out: HintSeg[] = [];
  shown.forEach((h, i) => {
    if (i > 0) out.push({ text: SEP, tone: 'dim' });
    out.push({ text: nbsp(h.key), tone: h.active ? 'active' : 'key' });
    out.push({ text: JOIN + nbsp(h.label), tone: 'dim' });
  });
  return out;
}

/**
 * How many rows the hints wrap to at `width`, so a fixed-height layout can reserve them and not
 * scroll the frame. Mirrors the terminal's word wrap given the non-breaking spaces above: each
 * hint is unbreakable, the ` · ` separators are the only break points (and are dropped at a
 * line start). `prefixWidth` is any leading text sharing the first line, e.g. a tab indicator.
 * Assumes prefix-plus-one-hint fits `width`; the caller guarantees it — the pane never renders
 * below MIN_PANE_W (46), several times the widest hint — so Ink's mid-word hard wrap cannot fire.
 */
export function hintRows(
  hints: readonly MaybeHint[],
  width: number,
  prefixWidth = 0,
): number {
  const shown = hints.filter((h): h is Hint => Boolean(h));
  if (!shown.length) return prefixWidth > 0 ? 1 : 0;
  if (width <= 0) return 1;
  let line = prefixWidth;
  let rows = 1;
  // A separator precedes a hint only when the current line already holds one — NOT merely when a
  // prefix made the line non-empty: the prefix (a tab indicator) carries its own trailing ` · `,
  // so the first hint follows that, not a second separator. Resets to false at every line break.
  let lineHasHint = false;
  for (const h of shown) {
    const unit = hintWidth(h);
    const add = (lineHasHint ? SEP.length : 0) + unit;
    if (line > 0 && line + add > width) {
      rows += 1;
      line = unit; // a wrapped line starts with the hint, its separator dropped at the break
    } else {
      line += add;
    }
    lineHasHint = true;
  }
  return rows;
}

/** Render the hints as a fragment of `<Text>` runs, so a caller can wrap and append its own. */
export function FooterHints({ hints }: { hints: readonly MaybeHint[] }) {
  return (
    <>
      {hintSegments(hints).map((s, i) => (
        <Text
          key={i}
          dimColor={s.tone === 'dim'}
          // Both key tones are bold; only the active one takes a colour.
          bold={s.tone !== 'dim'}
          color={s.tone === 'active' ? TONE_COLOUR.active : undefined}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}
