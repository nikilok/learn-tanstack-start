// The timeline picker. `submitRange` parsed operator input with no test over it at all, and the
// preset bookkeeping is what makes the list say which window is actually in force.

import { describe, expect, test } from 'bun:test';

import { WINDOW_PRESETS } from './time-window';
import {
  CUSTOM,
  CUSTOM_ROW,
  isCustomRow,
  moveWindowCursor,
  openCursor,
  presetForHours,
  rangeSelection,
  submitsOnPaste,
  typeRange,
} from './window-pick';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const DEFAULT_HOURS = 24;

describe('presetForHours', () => {
  test('finds the preset holding that many hours', () => {
    expect(WINDOW_PRESETS[presetForHours(24)].label).toBe('last 24h');
    expect(WINDOW_PRESETS[presetForHours(1)].label).toBe('last 1h');
  });

  test('an unlisted duration is custom, not a wrong preset', () => {
    expect(presetForHours(7)).toBe(CUSTOM);
  });
});

describe('openCursor', () => {
  test('opens on the preset in force, so the list starts where you are', () => {
    expect(openCursor(3)).toBe(3);
  });

  test('a custom range opens on the custom row', () => {
    expect(openCursor(CUSTOM)).toBe(CUSTOM_ROW);
  });
});

describe('moveWindowCursor', () => {
  test('moves through the presets', () => {
    expect(moveWindowCursor(0, 1)).toBe(1);
    expect(moveWindowCursor(2, -1)).toBe(1);
  });

  test('stops at the top rather than wrapping', () => {
    expect(moveWindowCursor(0, -1)).toBe(0);
  });

  test('the last row down is the custom row, and it stops there', () => {
    expect(moveWindowCursor(WINDOW_PRESETS.length - 1, 1)).toBe(CUSTOM_ROW);
    expect(moveWindowCursor(CUSTOM_ROW, 1)).toBe(CUSTOM_ROW);
  });

  test('every preset is reachable from the top', () => {
    let c = 0;
    for (let i = 0; i < WINDOW_PRESETS.length; i++) c = moveWindowCursor(c, 1);
    expect(c).toBe(CUSTOM_ROW);
  });
});

describe('isCustomRow', () => {
  test('the row past the presets opens the range field', () => {
    expect(isCustomRow(CUSTOM_ROW)).toBe(true);
  });

  test('a preset row does not', () => {
    expect(isCustomRow(0)).toBe(false);
    expect(isCustomRow(WINDOW_PRESETS.length - 1)).toBe(false);
  });
});

describe('rangeSelection', () => {
  // Marking blank as custom left the timeline list showing "custom… · in force" over a window
  // that was in fact a preset.
  test('blank reverts to the rolling default AND marks it as that preset', () => {
    const out = rangeSelection('', NOW, DEFAULT_HOURS);
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.presetIdx).toBe(presetForHours(DEFAULT_HOURS));
    expect(out.presetIdx).not.toBe(CUSTOM);
  });

  test('whitespace only counts as blank', () => {
    const out = rangeSelection('   ', NOW, DEFAULT_HOURS);
    if ('error' in out) throw new Error('expected a window');
    expect(out.presetIdx).toBe(presetForHours(DEFAULT_HOURS));
  });

  test('a typed range is custom, because no preset describes it', () => {
    const out = rangeSelection('08 09 2026 - 08 11 2026', NOW, DEFAULT_HOURS);
    if ('error' in out) throw new Error(`expected a window, got ${out.error}`);
    expect(out.presetIdx).toBe(CUSTOM);
    expect(out.window.fromISO).toBeDefined();
  });

  test('one date means that day up to now', () => {
    const out = rangeSelection('08 09 2026', NOW, DEFAULT_HOURS);
    if ('error' in out) throw new Error(`expected a window, got ${out.error}`);
    expect(out.presetIdx).toBe(CUSTOM);
  });

  test('an unparseable range returns the message rather than a window', () => {
    const out = rangeSelection('not a date', NOW, DEFAULT_HOURS);
    expect('error' in out).toBe(true);
  });

  test('a rejected range never claims a preset, so nothing is applied', () => {
    const out = rangeSelection('99 99 9999', NOW, DEFAULT_HOURS);
    expect('window' in out).toBe(false);
  });
});

describe('typeRange', () => {
  test('accepts digits and the separators a date uses', () => {
    expect(typeRange('', '08 09 2026')).toBe('08 09 2026');
    expect(typeRange('', '08/02/2026')).toBe('08/02/2026');
    expect(typeRange('08 09 2026 ', '- 08 11 2026')).toBe(
      '08 09 2026 - 08 11 2026',
    );
  });

  // Requiring the whole chunk to match meant pasting a range silently did nothing.
  test('a paste is filtered WITHIN the chunk, not rejected whole', () => {
    expect(typeRange('', 'from 08 02 2026')).toBe(' 08 02 2026');
  });

  test('letters are dropped rather than typed', () => {
    expect(typeRange('', 'abc')).toBe('');
  });

  test('a trailing newline is kept as whitespace — submitsOnPaste is what acts on it', () => {
    // The range is trimmed before parsing, so carrying it costs nothing and dropping it here
    // would hide the paste that the submit check reads.
    expect(typeRange('', '08 09 2026\n')).toBe('08 09 2026\n');
  });

  test('the field is bounded, so a huge paste cannot grow the frame', () => {
    expect(typeRange('', '1'.repeat(200)).length).toBe(32);
  });
});

describe('submitsOnPaste', () => {
  test('a chunk ending in a newline submits', () => {
    expect(submitsOnPaste('08 02 2026\n')).toBe(true);
    expect(submitsOnPaste('08 02 2026\r')).toBe(true);
  });

  test('ordinary typing does not', () => {
    expect(submitsOnPaste('8')).toBe(false);
  });

  // Found in review 2026-08-13. A newline in the MIDDLE is a multi-line paste, and submitting on
  // it sends whatever followed the break along with the range.
  test('a newline in the middle of a chunk does NOT submit', () => {
    expect(submitsOnPaste('08 09 2026\n08 11 2026')).toBe(false);
    expect(submitsOnPaste('a\nb')).toBe(false);
  });

  test('but the same chunk ending in one still does', () => {
    expect(submitsOnPaste('08 09 2026\n08 11 2026\n')).toBe(true);
  });
});
