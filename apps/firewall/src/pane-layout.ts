// How the two columns are sized, and what a picker row costs in cells.

export const PANE_SHARE = 0.7; // the pane holds the data; the rules list is names and a tag
// Enough for the deny rule names in full plus a pending marker. At 34 the two deny rules both
// truncated to "deny-sc…", which is worse than useless when one of them has a staged change.
export const MIN_RULES_W = 46;
// Below this the data pane cannot say anything useful, so it is hidden rather than squeezed.
export const MIN_PANE_W = 46;
export const PANE_GAP = 2; // marginRight between the two columns
// Every part of a picker row, so the width test cannot drift from what is drawn. Derived rather
// than written as one number: the space after the count lives in the JSX and was missed once.
const CURSOR_W = 2; // '▶ ' / '  '
export const COUNT_W = 7; // right-aligned request count
const ROW_W = CURSOR_W + COUNT_W + 1; // ... and the space before the identity
// The glyph is ambiguous-width so it is budgeted at 2 cells, and the leading space makes 3.
const FLAG_W = 3; // ' ⚑'
const OPEN_W = 7; // ' (open)'
export const ROW_CHROME = {
  row: ROW_W,
  cursor: CURSOR_W,
  flag: FLAG_W,
  open: OPEN_W,
};
