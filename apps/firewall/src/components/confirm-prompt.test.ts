// paneChrome reserves rows for this dialog in advance. It assumed a flat three, and the ASN
// detail is a paragraph — it wrapped past the reservation, grew the frame beyond the viewport,
// and scrolled the header and the editor cursor off screen.

import { describe, expect, test } from 'bun:test';

import { type Confirmation, confirmRows, wrappedRows } from './confirm-prompt';

const of = (prompt: string, detail: string): Confirmation => ({
  prompt,
  detail,
  onYes: () => {},
});

// The real one, verbatim from the ASN branch — the longest detail the tool produces.
const ASN_DETAIL =
  'NOTHING can reconcile that number with that name — the API exposes no AS-number dimension, so check it yourself. Large operators announce many ASNs. An ASN deny hits EVERY client on the network you type.';

describe('confirmRows', () => {
  test('a short dialog is the three rows it used to assume', () => {
    expect(confirmRows(of('Deny it?', 'takes effect on apply'), 80)).toBe(3);
  });

  test('the ASN warning needs far more than three, which is the whole bug', () => {
    const rows = confirmRows(of('Deny AS14061?', ASN_DETAIL), 60);
    expect(rows).toBeGreaterThan(3);
  });

  test('a narrower pane needs more rows than a wide one', () => {
    const wide = confirmRows(of('Deny AS14061?', ASN_DETAIL), 120);
    const narrow = confirmRows(of('Deny AS14061?', ASN_DETAIL), 40);
    expect(narrow).toBeGreaterThan(wide);
  });

  // Counting characters would under-count, because wrapping never splits a word.
  test('it never under-counts a line whose words do not divide evenly', () => {
    const detail = 'aaaaaa bbbbbb cccccc'; // 20 chars, but no two fit in 12
    expect(confirmRows(of('x', detail), 12)).toBeGreaterThanOrEqual(1 + 2 + 1);
  });

  test('a degenerate width still reserves something rather than zero', () => {
    expect(confirmRows(of('x', 'y'), 0)).toBeGreaterThan(0);
  });

  // A JA4 digest is 37 characters and never breaks, so in a narrow pane it occupies more than one
  // row on its own. Charging it one is how the reservation ends up short again.
  test('a word wider than the row counts as the rows it actually spans', () => {
    const digest = 't13d1516h2_8daaf6152771_b0da82dd1658'; // 36
    expect(confirmRows(of('x', digest), 12)).toBeGreaterThanOrEqual(1 + 3 + 1);
  });

  // An exact multiple left the row measured as empty, so the next word did not wrap and the
  // reservation came up one short again.
  test('a word that is an exact multiple of the width fills its last row', () => {
    expect(confirmRows(of('x', `${'a'.repeat(24)} b`), 12)).toBe(1 + 3 + 1);
  });

  test('an explicit newline starts a new row', () => {
    expect(confirmRows(of('x', 'a\nb\nc'), 80)).toBe(1 + 3 + 1);
  });
});

// The watch panel's row budget is built from this, so anything it under-counts is a row the
// panel takes without having reserved it.
describe('wrappedRows', () => {
  test('a line that fits is one row', () => {
    expect(wrappedRows('short', 40)).toBe(1);
  });

  // split(' ') yields a zero-length word per leading space, and those left `used` at zero — so
  // indentation cost no columns and an indented line measured one row while Ink drew two.
  test('leading spaces cost columns, like every other character', () => {
    expect(wrappedRows(`  ${'x'.repeat(39)}`, 40)).toBe(2);
  });

  test('an indented bullet wraps where an unindented one would not', () => {
    const text = 'x'.repeat(38);
    expect(wrappedRows(text, 40)).toBe(1);
    expect(wrappedRows(`    ${text}`, 40)).toBe(2);
  });

  test('a word wider than the row spans the rows it needs', () => {
    expect(wrappedRows('x'.repeat(85), 40)).toBe(3);
  });

  test('each newline starts a new row', () => {
    expect(wrappedRows('a\nb\nc', 40)).toBe(3);
  });

  test('a zero width is one row rather than a division by zero', () => {
    expect(wrappedRows('anything', 0)).toBe(1);
  });
});
