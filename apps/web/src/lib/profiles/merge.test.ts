import { describe, expect, test } from 'bun:test';

import type { ProfileQuestion } from './extract';
import { MAX_LIST_ITEMS, mergeAnswers, type PageCandidate } from './merge';

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

function page(
  path: string,
  answers: PageCandidate['answers'],
): PageCandidate {
  return { path, url: `https://example.co.uk${path || '/'}`, answers };
}

describe('mergeAnswers', () => {
  test('prose prefers about over home over services, whatever the input order', () => {
    const merged = mergeAnswers(QUESTIONS, [
      page('/care-services', {
        what_does: 'From services.',
        offerings: [],
      }),
      page('', { what_does: 'From home.', offerings: [] }),
      page('/about-us', { what_does: 'From about.', offerings: [] }),
    ]);
    expect(merged.what_does).toEqual({
      kind: 'prose',
      status: 'ok',
      answer: 'From about.',
      sourceUrls: ['https://example.co.uk/about-us'],
    });
  });

  test('prose falls through pages that did not say', () => {
    const merged = mergeAnswers(QUESTIONS, [
      page('/about-us', { what_does: null, offerings: [] }),
      page('', { what_does: 'From home.', offerings: [] }),
    ]);
    expect(merged.what_does).toEqual({
      kind: 'prose',
      status: 'ok',
      answer: 'From home.',
      sourceUrls: ['https://example.co.uk/'],
    });
  });

  test('lists union across pages with normalised dedupe, first wording kept', () => {
    const merged = mergeAnswers(QUESTIONS, [
      page('/about-us', {
        what_does: null,
        offerings: ['Home Care', 'Respite care.'],
      }),
      page('/care-services', {
        what_does: null,
        offerings: ['home  care', 'Dementia care', 'RESPITE CARE'],
      }),
    ]);
    expect(merged.offerings).toEqual({
      kind: 'list',
      status: 'ok',
      items: ['Home Care', 'Respite care.', 'Dementia care'],
      sourceUrls: [
        'https://example.co.uk/about-us',
        'https://example.co.uk/care-services',
      ],
    });
  });

  test('nothing anywhere is insufficient_content, never a guess', () => {
    const merged = mergeAnswers(QUESTIONS, [
      page('', { what_does: null, offerings: [] }),
    ]);
    expect(merged.what_does.status).toBe('insufficient_content');
    expect(merged.offerings.status).toBe('insufficient_content');
    expect(merged.what_does.sourceUrls).toEqual([]);
  });

  test('source urls name only the pages that contributed', () => {
    const merged = mergeAnswers(QUESTIONS, [
      page('/about-us', { what_does: 'Identity.', offerings: [] }),
      page('/care-services', { what_does: null, offerings: ['Care'] }),
    ]);
    expect(merged.what_does.sourceUrls).toEqual([
      'https://example.co.uk/about-us',
    ]);
    expect(merged.offerings.sourceUrls).toEqual([
      'https://example.co.uk/care-services',
    ]);
  });

  test('the union caps rather than bloating an answer row', () => {
    const merged = mergeAnswers(QUESTIONS, [
      page('', {
        what_does: null,
        offerings: Array.from({ length: 80 }, (_, i) => `Item ${i}`),
      }),
    ]);
    expect(merged.offerings).toEqual({
      kind: 'list',
      status: 'ok',
      items: Array.from({ length: MAX_LIST_ITEMS }, (_, i) => `Item ${i}`),
      sourceUrls: ['https://example.co.uk/'],
    });
  });
});
