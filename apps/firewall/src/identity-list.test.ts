// The quiet band exists because the top of a volume-ranked list is the one place a scraper can
// choose not to be. These lock the two ways the idea fails: showing the true bottom (noise no
// one can act on) and showing rows the busiest column already has.

import { describe, expect, test } from 'bun:test';

import {
  QUIET_FLOOR,
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

describe('pickerLayout', () => {
  // count + cursor gutter + space, matching ROW_W in app.tsx.
  const CHROME = 9;
  const GAP = 2;
  const lay = (b: number, q: number, idW: number, w: number) =>
    pickerLayout(b, q, idW, w, CHROME, GAP);

  test('two columns when the width is there', () => {
    // 2 * (9 + 36) + 2 = 92 for JA4 digests.
    expect(lay(8, 10, 36, 92).twoCol).toBe(true);
    expect(lay(8, 10, 36, 91).twoCol).toBe(false);
  });

  test('IPv4 fits two columns where a JA4 digest does not', () => {
    expect(lay(8, 10, 15, 60).twoCol).toBe(true);
    expect(lay(8, 10, 36, 60).twoCol).toBe(false);
  });

  test('never two columns with no quiet band — nothing to put beside it', () => {
    expect(lay(8, 0, 15, 500).twoCol).toBe(false);
  });

  test('side by side reserves the taller column, not the sum', () => {
    expect(lay(8, 10, 15, 200).rows).toBe(11); // max(8,10) + caption
    expect(lay(10, 3, 15, 200).rows).toBe(11); // max(10,3) + caption
  });

  test('stacked reserves both plus the divider', () => {
    expect(lay(8, 10, 36, 40).rows).toBe(19);
  });

  test('no quiet band means no caption row is reserved', () => {
    // Reserving one anyway would shrink the pane by a row that is never drawn.
    expect(lay(8, 0, 15, 200).rows).toBe(8);
  });

  test('an empty picker reserves nothing', () => {
    expect(lay(0, 0, 0, 200)).toEqual({ twoCol: false, rows: 0 });
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
