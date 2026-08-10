import { describe, expect, test } from 'bun:test';

import { answerRows, type AnswerStamps } from './answers';
import { askHashInput, type ProfileQuestion } from './extract';

const QUESTIONS: ProfileQuestion[] = [
  {
    slug: 'what_does',
    prompt: 'What does this company do?',
    kind: 'prose',
    intent: 'identity',
    sort: 1,
  },
  {
    slug: 'offerings',
    prompt: 'What products or services does this company provide?',
    kind: 'list',
    intent: 'offerings',
    sort: 2,
  },
];

const STAMPS: AnswerStamps = {
  hashes: new Map([
    ['what_does', 'hash-a'],
    ['offerings', 'hash-b'],
  ]),
  model: 'gemma-4-E2B-it@rev',
  identityEvidence: 'crn_on_page',
};

describe('askHashInput', () => {
  test('changes with prompt, kind or intent — never with sort or slug', () => {
    const base = askHashInput(QUESTIONS[0]);
    expect(askHashInput({ ...QUESTIONS[0], prompt: 'Other?' })).not.toBe(base);
    expect(askHashInput({ ...QUESTIONS[0], kind: 'list' })).not.toBe(base);
    expect(askHashInput({ ...QUESTIONS[0], intent: 'other' })).not.toBe(base);
    expect(askHashInput({ ...QUESTIONS[0], sort: 9 })).toBe(base);
    expect(askHashInput({ ...QUESTIONS[0], slug: 'renamed' })).toBe(base);
  });
});

describe('answerRows', () => {
  test('a merged outcome maps prose and list onto their own columns', () => {
    const rows = answerRows(
      '01234567',
      QUESTIONS,
      {
        kind: 'merged',
        merged: {
          what_does: {
            kind: 'prose',
            status: 'ok',
            answer: 'Provides care.',
            sourceUrls: ['https://x/about'],
          },
          offerings: {
            kind: 'list',
            status: 'ok',
            items: ['Home care'],
            sourceUrls: ['https://x/'],
          },
        },
      },
      STAMPS,
    );
    expect(rows).toEqual([
      {
        companyNumber: '01234567',
        questionSlug: 'what_does',
        questionHash: 'hash-a',
        questionText: 'What does this company do?',
        answer: 'Provides care.',
        items: null,
        sourceUrls: ['https://x/about'],
        identityEvidence: 'crn_on_page',
        model: 'gemma-4-E2B-it@rev',
        status: 'ok',
      },
      {
        companyNumber: '01234567',
        questionSlug: 'offerings',
        questionHash: 'hash-b',
        questionText: 'What products or services does this company provide?',
        answer: null,
        items: ['Home care'],
        sourceUrls: ['https://x/'],
        identityEvidence: 'crn_on_page',
        model: 'gemma-4-E2B-it@rev',
        status: 'ok',
      },
    ]);
  });

  test('insufficient merges and unreadable origins both close as insufficient_content', () => {
    const insufficient = answerRows(
      '01234567',
      QUESTIONS,
      {
        kind: 'merged',
        merged: {
          what_does: {
            kind: 'prose',
            status: 'insufficient_content',
            sourceUrls: [],
          },
          offerings: {
            kind: 'list',
            status: 'insufficient_content',
            sourceUrls: [],
          },
        },
      },
      STAMPS,
    );
    const unreadable = answerRows(
      '01234567',
      QUESTIONS,
      { kind: 'no_readable_pages' },
      STAMPS,
    );
    for (const rows of [insufficient, unreadable]) {
      expect(rows.map((row) => row.status)).toEqual([
        'insufficient_content',
        'insufficient_content',
      ]);
      expect(rows.every((row) => row.sourceUrls.length === 0)).toBe(true);
      expect(rows.every((row) => row.answer === null && row.items === null)).toBe(
        true,
      );
    }
  });

  test('a model failure is error, never a silent insufficient', () => {
    const rows = answerRows(
      '01234567',
      QUESTIONS,
      { kind: 'model_failure' },
      STAMPS,
    );
    expect(rows.map((row) => row.status)).toEqual(['error', 'error']);
  });

  test('a question without a computed hash is a programming error', () => {
    expect(() =>
      answerRows(
        '01234567',
        QUESTIONS,
        { kind: 'no_readable_pages' },
        { ...STAMPS, hashes: new Map() },
      ),
    ).toThrow(/no ask hash/);
  });
});
