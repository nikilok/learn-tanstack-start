// The footer key/label bar, one definition so every footer in the TUI reads the same way:
// the key you press in the accent colour, what it does dimmed beside it, lazygit-style.
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

const TONE_COLOUR: Record<'key' | 'active', string> = {
  key: 'cyan',
  active: 'green',
};

// A hint is one unbreakable unit when wrapped, so its own spaces are non-breaking and only the
// separators between hints break — otherwise `w timeline` splits with the key stranded a line up.
const NBSP = ' ';
const nbsp = (s: string) => s.replace(/ /g, NBSP);
const SEP = ' · ';

/** The width one hint occupies: key, a joining space, and its label. */
function hintWidth(h: Hint): number {
  return h.key.length + 1 + h.label.length;
}

/** Flatten hints to coloured segments: `key label · key label`, separators and labels dim. */
export function hintSegments(hints: readonly MaybeHint[]): HintSeg[] {
  const shown = hints.filter((h): h is Hint => Boolean(h));
  const out: HintSeg[] = [];
  shown.forEach((h, i) => {
    if (i > 0) out.push({ text: SEP, tone: 'dim' });
    out.push({ text: nbsp(h.key), tone: h.active ? 'active' : 'key' });
    out.push({ text: NBSP + nbsp(h.label), tone: 'dim' });
  });
  return out;
}

/**
 * How many rows the hints wrap to at `width`, so a fixed-height layout can reserve them and not
 * scroll the frame. Mirrors the terminal's word wrap given the non-breaking spaces above: each
 * hint is unbreakable, the ` · ` separators are the only break points (and are dropped at a
 * line start). `prefixWidth` is any leading text sharing the first line, e.g. a tab indicator.
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
          bold={s.tone === 'active'}
          color={s.tone === 'dim' ? undefined : TONE_COLOUR[s.tone]}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}
