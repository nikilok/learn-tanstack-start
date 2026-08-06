// The quiet band exists because the top of a volume-ranked list is the one place a scraper can
// choose not to be. These lock the two ways the idea fails: showing the true bottom (noise no
// one can act on) and showing rows the busiest column already has.

import { describe, expect, test } from 'bun:test';

import {
  QUIET_FLOOR,
  columnWidth,
  noAlpn,
  pickable,
  pickerLayout,
  quietBand,
} from './identity-list';

const rows = (...counts: number[]): [string, number][] =>
  counts.map((c, i) => [`ip-${i}`, c]);

describe('quietBand', () => {
  test('takes the lowest above the floor, lowest first', () => {
    expect(quietBand(rows(9000, 800, 400, 300, 200), 1, 3)).toEqual([
      ['ip-4', 200],
      ['ip-3', 300],
      ['ip-2', 400],
    ]);
  });

  test('skips what the busiest column already shows', () => {
    // Otherwise the two columns overlap and the quiet one stops meaning anything.
    const out = quietBand(rows(9000, 8000, 700, 600), 2, 5);
    expect(out.map(([k]) => k)).toEqual(['ip-3', 'ip-2']);
  });

  test('drops everything under the floor — that end of the list is noise', () => {
    // A single-request visitor is not hiding, and could not be adjudicated if it were: it
    // cannot clear the advisory's volume requirement.
    expect(quietBand(rows(9000, 1, 1, 1), 1, 5)).toEqual([]);
  });

  test('keeps a row exactly at the floor', () => {
    expect(quietBand(rows(9000, QUIET_FLOOR), 1, 5)).toEqual([
      ['ip-1', QUIET_FLOOR],
    ]);
  });

  test('returns fewer than asked rather than padding', () => {
    expect(quietBand(rows(9000, 500), 1, 10)).toHaveLength(1);
  });

  test('empty when the busiest column already covers everything', () => {
    expect(quietBand(rows(9000, 800), 2, 5)).toEqual([]);
  });

  test('count of zero asks for nothing', () => {
    expect(quietBand(rows(9000, 800, 700), 1, 0)).toEqual([]);
  });
});

describe('noAlpn', () => {
  test('flags a fingerprint that offered no ALPN', () => {
    expect(noAlpn('t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb')).toBe(true);
  });

  test('does not flag one that negotiated h2', () => {
    expect(noAlpn('t13dbingh2_333333333333_444444444444')).toBe(false);
  });

  test('a malformed digest is not a tell', () => {
    // An unparseable value must not read as evidence — it is an unknown, and unknowns do not
    // get marked as suspicious.
    expect(noAlpn('')).toBe(false);
    expect(noAlpn('t13d')).toBe(false);
  });
});

// The markers are drawn after the identity, so a column that fits bare can overflow the moment a
// row is flagged or opened — and an overflowing row wraps, costing a line nothing reserved.
describe('columnWidth', () => {
  const C = { row: 10, cursor: 2, flag: 3, open: 7 };
  const none = () => false;
  const all = () => true;
  const ip = (s: string): [string, number][] => [[s, 500]];

  test('a bare row is chrome plus the identity', () => {
    expect(columnWidth(ip('1.2.3.4'), 'x', none, none, C)).toBe(17);
  });

  test('a flag widens the column', () => {
    expect(columnWidth(ip('1.2.3.4'), 'x', all, none, C)).toBe(20);
  });

  test('an (open) suffix widens it further', () => {
    expect(columnWidth(ip('1.2.3.4'), 'x', none, all, C)).toBe(24);
    expect(columnWidth(ip('1.2.3.4'), 'x', all, all, C)).toBe(27);
  });

  test('only the flagged row counts, not every row', () => {
    const rows: [string, number][] = [
      ['1.2.3.4', 9],
      ['5.6.7.8', 9],
    ];
    const onlyFirst = (id: string) => id === '1.2.3.4';
    expect(columnWidth(rows, 'x', onlyFirst, none, C)).toBe(20);
  });

  test('the caption wins when it is wider than every row', () => {
    // 'quietest over 100' (17) plus the two-space indent is 19, wider than a short IP row.
    expect(columnWidth(ip('1.2'), 'quietest over 100', none, none, C)).toBe(19);
  });

  test('an empty column still has to fit its caption', () => {
    // Not zero: the caption is drawn whether or not any row is.
    expect(columnWidth([], 'quietest over 100', none, none, C)).toBe(19);
  });

  test('the widest row sets the width', () => {
    const rows: [string, number][] = [
      ['1.2.3.4', 9],
      ['255.255.255.255', 9],
    ];
    expect(columnWidth(rows, 'x', none, none, C)).toBe(25);
  });
});

describe('pickerLayout', () => {
  const GAP = 2;
  // Mirrors app.tsx: cursor gutter (2) + count (7) + the space before the identity (1). That last
  // one lives in the JSX and was once left out of the constant, which chose two columns two cells
  // short of what a JA4 row draws.
  const ROW = 10;
  const lay = (b: number, q: number, l: number, r: number, w: number) =>
    pickerLayout(b, q, l, r, w, GAP);

  test('two columns exactly when both fit with the gap', () => {
    // A 36-char digest row is 46 wide; two of them plus the gap is 94.
    expect(lay(8, 10, ROW + 36, ROW + 36, 94).twoCol).toBe(true);
    expect(lay(8, 10, ROW + 36, ROW + 36, 93).twoCol).toBe(false);
  });

  test('IPv4 fits two columns where a JA4 digest does not', () => {
    expect(lay(8, 10, ROW + 15, ROW + 15, 60).twoCol).toBe(true);
    expect(lay(8, 10, ROW + 36, ROW + 36, 60).twoCol).toBe(false);
  });

  test('a flag or an (open) suffix can be what tips it to stacked', () => {
    // The markers are drawn after the identity, so a column that fits bare can overflow once a
    // row is flagged or opened — and an overflowing row wraps, costing an unreserved line.
    expect(lay(8, 10, ROW + 36, ROW + 36, 94).twoCol).toBe(true);
    expect(lay(8, 10, ROW + 36 + 3, ROW + 36, 94).twoCol).toBe(false); // ' ⚑'
    expect(lay(8, 10, ROW + 36, ROW + 36 + 7, 94).twoCol).toBe(false); // ' (open)'
  });

  test('the columns are measured independently, not doubled', () => {
    // A wide busiest column must not force the narrow quiet one to stack with it.
    expect(lay(8, 10, 46, 26, 74).twoCol).toBe(true);
  });

  test('never two columns with no quiet band — nothing to put beside it', () => {
    expect(lay(8, 0, 20, 0, 500).twoCol).toBe(false);
  });

  test('side by side reserves the taller column, not the sum', () => {
    expect(lay(8, 10, 25, 25, 200).rows).toBe(11); // max(8,10) + caption
    expect(lay(10, 3, 25, 25, 200).rows).toBe(11); // max(10,3) + caption
  });

  test('stacked reserves both plus the divider', () => {
    expect(lay(8, 10, 46, 46, 40).rows).toBe(19);
  });

  test('no quiet band means no caption row is reserved', () => {
    // Reserving one anyway would shrink the pane by a row that is never drawn.
    expect(lay(8, 0, 25, 0, 200).rows).toBe(8);
  });

  test('an empty picker reserves nothing', () => {
    expect(lay(0, 0, 0, 0, 200)).toEqual({ twoCol: false, rows: 0 });
  });
});

describe('pickable', () => {
  test('busiest first, then the quiet band', () => {
    expect(pickable(rows(900), [['q', 100]])).toEqual([
      ['ip-0', 900],
      ['q', 100],
    ]);
  });

  test('flat even when a side is empty', () => {
    expect(pickable([], [['q', 100]])).toEqual([['q', 100]]);
    expect(pickable(rows(900), [])).toEqual([['ip-0', 900]]);
  });
});
