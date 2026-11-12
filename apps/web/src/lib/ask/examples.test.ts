import { describe, expect, test } from 'bun:test';

import { askEligible } from './eligibility';
import {
  advanceExamples,
  ASK_EXAMPLES,
  EXAMPLE_ENTER_MS,
  EXAMPLE_ERASE_MS,
  EXAMPLE_HOLD_MS,
  EXAMPLE_TYPE_MS,
  exampleDwellMs,
  exampleWaitMs,
  FIRST_EXAMPLE,
  letters,
} from './examples';

/** The longest example worth typing out, in characters: past this a phone wraps it and the typing drags. */
const LONGEST = 44;

describe('ASK_EXAMPLES', () => {
  test('each clears the gate the box applies to a typed text, so asking one as written never does nothing', () => {
    for (const text of ASK_EXAMPLES) {
      expect(
        askEligible({
          confirmedEmpty: true,
          text,
          ready: true,
          preview: false,
        }),
      ).toBe(true);
    }
  });

  test('each stays short, and none repeats', () => {
    for (const text of ASK_EXAMPLES) {
      expect(letters(text).length).toBeLessThanOrEqual(LONGEST);
    }
    expect(new Set(ASK_EXAMPLES).size).toBe(ASK_EXAMPLES.length);
  });

  test('each reads as typed: no dash standing in for a word, no closing punctuation, no surrounding space', () => {
    for (const text of ASK_EXAMPLES) {
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/[.?!:]$/);
    }
  });
});

describe('advanceExamples', () => {
  test('shows the next with the shown one leaving, and wraps to the first past the last', () => {
    const second = advanceExamples(FIRST_EXAMPLE, 3);
    expect(second).toEqual({ shown: 1, leaving: 0 });
    const third = advanceExamples(second, 3);
    expect(third).toEqual({ shown: 2, leaving: 1 });
    expect(advanceExamples(third, 3)).toEqual({ shown: 0, leaving: 2 });
  });

  test('a lone example is shown again', () => {
    expect(advanceExamples(FIRST_EXAMPLE, 1)).toEqual({ shown: 0, leaving: 0 });
  });

  test('walks the whole list once per round by default', () => {
    let rotation = FIRST_EXAMPLE;
    const seen = new Set<number>();
    for (let i = 0; i < ASK_EXAMPLES.length; i++) {
      seen.add(rotation.shown);
      rotation = advanceExamples(rotation);
    }
    expect(seen.size).toBe(ASK_EXAMPLES.length);
    expect(rotation).toEqual({ shown: 0, leaving: ASK_EXAMPLES.length - 1 });
  });
});

describe('letters', () => {
  test('one per character as typed, spaces among them', () => {
    expect(letters('care homes')).toEqual([
      'c',
      'a',
      'r',
      'e',
      ' ',
      'h',
      'o',
      'm',
      'e',
      's',
    ]);
    expect(letters('')).toEqual([]);
  });
});

describe('exampleWaitMs and exampleDwellMs', () => {
  test('the first example waits for the row to enter; every later one for the erase of the one it replaces', () => {
    expect(exampleWaitMs(FIRST_EXAMPLE)).toBe(EXAMPLE_ENTER_MS);
    expect(exampleWaitMs(advanceExamples(FIRST_EXAMPLE))).toBe(
      EXAMPLE_ERASE_MS,
    );
  });

  test('a dwell is the wait, a beat per letter and the hold', () => {
    const examples = ['x', 'care homes'];
    expect(exampleDwellMs({ shown: 1, leaving: 0 }, examples)).toBe(
      EXAMPLE_ERASE_MS + 10 * EXAMPLE_TYPE_MS + EXAMPLE_HOLD_MS,
    );
    expect(exampleDwellMs({ shown: 0, leaving: null }, examples)).toBe(
      EXAMPLE_ENTER_MS + EXAMPLE_TYPE_MS + EXAMPLE_HOLD_MS,
    );
  });

  test('an erase is quicker than the shortest example types', () => {
    const shortest = Math.min(
      ...ASK_EXAMPLES.map((text) => letters(text).length),
    );
    expect(EXAMPLE_ERASE_MS).toBeLessThan(shortest * EXAMPLE_TYPE_MS);
  });
});
