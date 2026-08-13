// paneChrome reserves rows for this dialog in advance. It assumed a flat three, and the ASN
// detail is a paragraph — it wrapped past the reservation, grew the frame beyond the viewport,
// and scrolled the header and the editor cursor off screen.

import { describe, expect, test } from 'bun:test';

import { type Confirmation, confirmRows } from './confirm-prompt';

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
});
