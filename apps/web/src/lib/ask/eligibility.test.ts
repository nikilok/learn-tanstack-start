import { describe, expect, test } from 'bun:test';

import {
  askEligible,
  askWordCount,
  extendsEmptyPrefix,
  MAX_QUESTION_CHARS,
  MIN_ASK_WORDS,
} from './eligibility';

const base = {
  confirmedEmpty: true,
  text: 'care homes in leeds',
  ready: true,
  preview: false,
};

describe('askWordCount', () => {
  test('counts words across any whitespace', () => {
    expect(askWordCount('  care   homes\tin leeds ')).toBe(4);
    expect(askWordCount('')).toBe(0);
    expect(askWordCount('   ')).toBe(0);
  });
});

describe('extendsEmptyPrefix', () => {
  test('only a longer text that starts with the empty prefix extends it', () => {
    expect(extendsEmptyPrefix('show me a list of', 'show me a')).toBe(true);
    expect(extendsEmptyPrefix('show me a', 'show me a')).toBe(false);
    expect(extendsEmptyPrefix('show me', 'show me a')).toBe(false);
    expect(extendsEmptyPrefix('care homes in leeds', 'show me a')).toBe(false);
    expect(extendsEmptyPrefix('anything', null)).toBe(false);
  });
});

describe('askEligible', () => {
  test('eligible once the name search is confirmed empty on a description', () => {
    expect(askEligible(base)).toBe(true);
  });

  test('never while the search still has rows or is loading', () => {
    expect(askEligible({ ...base, confirmedEmpty: false })).toBe(false);
  });

  test(`never under ${MIN_ASK_WORDS} words: a short miss is a name that is not on the register`, () => {
    expect(askEligible({ ...base, text: 'checkatrade' })).toBe(false);
    expect(askEligible({ ...base, text: 'check point' })).toBe(false);
    expect(askEligible({ ...base, text: 'check point software' })).toBe(true);
  });

  test('never before the document is ready to mint a token', () => {
    expect(askEligible({ ...base, ready: false })).toBe(false);
  });

  test('never in the /download preview', () => {
    expect(askEligible({ ...base, preview: true })).toBe(false);
  });

  test(`never over ${MAX_QUESTION_CHARS} characters, counted as the server counts them`, () => {
    // Three words, exactly at the cap.
    const atCap = `a b ${'c'.repeat(MAX_QUESTION_CHARS - 4)}`;
    expect([...atCap].length).toBe(MAX_QUESTION_CHARS);
    expect(askEligible({ ...base, text: atCap })).toBe(true);
    expect(askEligible({ ...base, text: `${atCap}c` })).toBe(false);
    // Code points, not UTF-16 units: an emoji is one character to both sides.
    const emoji = `a b ${'🏥'.repeat(MAX_QUESTION_CHARS - 4)}`;
    expect(emoji.length).toBeGreaterThan(MAX_QUESTION_CHARS);
    expect([...emoji].length).toBe(MAX_QUESTION_CHARS);
    expect(askEligible({ ...base, text: emoji })).toBe(true);
    expect(askEligible({ ...base, text: `${emoji}🏥` })).toBe(false);
  });
});
