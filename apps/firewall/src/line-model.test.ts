import { describe, expect, test } from 'bun:test';

import {
  type Line,
  countRows,
  labelledRows,
  line,
  lineText,
  seg,
  toAnsi,
  truncate,
} from './line-model';

const ESC = '';

describe('truncate', () => {
  const l: Line = line(seg('abcdef', 'bold'), seg('ghijkl', 'dim'));

  test('leaves a short line alone', () => {
    expect(truncate(l, 99)).toEqual(l);
  });

  test('clips across segments and marks the cut', () => {
    expect(lineText(truncate(l, 8))).toBe('abcdefg…');
  });

  test('clipping inside the first segment keeps its tone', () => {
    const out = truncate(l, 4);
    expect(lineText(out)).toBe('abc…');
    expect(out[0].tone).toBe('bold');
  });

  test('a zero or negative width is a no-op rather than a crash', () => {
    expect(truncate(l, 0)).toEqual(l);
    expect(truncate(l, -5)).toEqual(l);
  });
});

describe('toAnsi', () => {
  const l = [line(seg('warn', 'warn'), ' plain')];

  test('colour off emits no escape sequences', () => {
    const out = toAnsi(l, { colour: false });
    expect(out).toBe('warn plain');
    expect(out).not.toContain(ESC);
  });

  test('colour on wraps toned segments and resets them', () => {
    const out = toAnsi(l, { colour: true });
    expect(out).toContain(`${ESC}[33mwarn${ESC}[0m`);
    expect(out).toContain(' plain');
  });

  test('width clips before colouring, so no escape is ever split', () => {
    const out = toAnsi([line(seg('abcdefghij', 'good'))], {
      colour: true,
      width: 5,
    });
    // Exactly one open and one reset per toned segment, plus the dim ellipsis.
    expect(out.split(`${ESC}[0m`).length - 1).toBe(2);
  });

  test('blank lines survive as empty output lines', () => {
    expect(toAnsi([line('a'), [], line('b')], { colour: false })).toBe('a\n\nb');
  });
});

describe('countRows', () => {
  const rows: [string, number][] = [
    ['a', 10],
    ['b', 5],
    ['c', 3],
    ['d', 2],
  ];

  test('renders count-first and states what it dropped', () => {
    const out = countRows(rows, 2).map(lineText);
    expect(out[0]).toContain('10  a');
    expect(out).toHaveLength(3);
    expect(out[2]).toContain('+2 more (5 req)');
  });

  test('no tail line when everything fits', () => {
    expect(countRows(rows, 4)).toHaveLength(4);
  });
});

describe('labelledRows', () => {
  test('shows the label once, then indents', () => {
    const out = labelledRows('JA4', [['x', 2], ['y', 1]], 4).map(lineText);
    expect(out[0]).toContain('JA4');
    expect(out[1]).not.toContain('JA4');
    expect(out[1].startsWith('  '.padEnd(11))).toBe(true);
  });

  test('empty input produces nothing', () => {
    expect(labelledRows('JA4', [], 4)).toEqual([]);
  });
});
