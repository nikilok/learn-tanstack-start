import { describe, expect, test } from 'bun:test';

import { estimateTokens, truncateToTokenBudget } from './clean';
import {
  assertAskFits,
  buildAskPrompt,
  MIN_PAGE_BUDGET_TOKENS,
  OUTPUT_HEADROOM_TOKENS,
  pageTextBudget,
  parsePageAnswers,
  type ProfileQuestion,
  SYSTEM_PROMPT,
} from './extract';

const QUESTIONS: ProfileQuestion[] = [
  {
    slug: 'what_does',
    prompt: 'What does this company do?',
    kind: 'prose',
    intent: 'The one-paragraph identity of the business.',
    sort: 1,
  },
  {
    slug: 'offerings',
    prompt: 'What products or services does this company provide?',
    kind: 'list',
    intent: 'The concrete things the company sells or does for clients.',
    sort: 2,
  },
];

describe('buildAskPrompt', () => {
  test('carries every question in sort order with its intent', () => {
    const prompt = buildAskPrompt(
      [QUESTIONS[1], QUESTIONS[0]],
      'https://example.co.uk',
      'text',
    );
    expect(prompt.indexOf('what_does')).toBeLessThan(
      prompt.indexOf('offerings'),
    );
    expect(prompt).toContain('The one-paragraph identity of the business.');
    expect(prompt).toContain('"what_does": string | null');
    expect(prompt).toContain('"offerings": string[]');
    expect(prompt.endsWith('text')).toBe(true);
  });

  test('property: a budget-truncated page always fits the window', () => {
    const contextTokens = 8192;
    const budget = pageTextBudget(QUESTIONS, contextTokens);
    expect(budget).toBeGreaterThan(MIN_PAGE_BUDGET_TOKENS);
    // Seeded LCG so a failure reproduces.
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const longUrl = `https://example.co.uk/${'segment/'.repeat(80)}`;
    const cases = Array.from({ length: 40 }, () =>
      'word '.repeat(Math.floor(rand() * 40_000)),
    );
    // The largest text a snapshot can carry: web-fetch's 2MB cap, cleaned.
    cases.push('lorem ipsum '.repeat(180_000));
    for (const text of cases) {
      const prompt = buildAskPrompt(
        QUESTIONS,
        longUrl,
        truncateToTokenBudget(text, budget),
      );
      // The real request carries the system prompt too; the budget must
      // leave room for it or a truncated page can still overflow.
      expect(
        estimateTokens(SYSTEM_PROMPT) +
          estimateTokens(prompt) +
          OUTPUT_HEADROOM_TOKENS,
      ).toBeLessThanOrEqual(contextTokens);
    }
  });

  test('assertAskFits refuses a window the ask cannot use', () => {
    expect(() => assertAskFits(QUESTIONS, 700)).toThrow(/Shard the question/);
    expect(assertAskFits(QUESTIONS, 8192)).toBeGreaterThan(
      MIN_PAGE_BUDGET_TOKENS,
    );
  });
});

describe('parsePageAnswers', () => {
  test('accepts a fenced response with surrounding prose', () => {
    const raw = `Here is the answer you asked for:
\`\`\`json
{"what_does": "Provides domiciliary care across Sussex.", "offerings": [" Home care ", "Respite care", ""]}
\`\`\``;
    const parsed = parsePageAnswers(raw, QUESTIONS);
    expect(parsed).toEqual({
      ok: true,
      answers: {
        what_does: 'Provides domiciliary care across Sussex.',
        offerings: ['Home care', 'Respite care'],
      },
    });
  });

  test('null and empty are first-class "the page does not say"', () => {
    const parsed = parsePageAnswers(
      '{"what_does": null, "offerings": []}',
      QUESTIONS,
    );
    expect(parsed).toEqual({
      ok: true,
      answers: { what_does: null, offerings: [] },
    });
    // A whitespace-only prose answer normalises to null, not to ''.
    const blank = parsePageAnswers(
      '{"what_does": "  ", "offerings": []}',
      QUESTIONS,
    );
    expect(blank.ok && blank.answers.what_does).toBe(null);
  });

  test('a missing key or wrong shape fails the whole response', () => {
    expect(parsePageAnswers('{"what_does": "x"}', QUESTIONS).ok).toBe(false);
    expect(
      parsePageAnswers('{"what_does": 42, "offerings": []}', QUESTIONS).ok,
    ).toBe(false);
    expect(
      parsePageAnswers('{"what_does": null, "offerings": "care"}', QUESTIONS)
        .ok,
    ).toBe(false);
    expect(
      parsePageAnswers('{"what_does": null, "offerings": [1]}', QUESTIONS).ok,
    ).toBe(false);
    expect(parsePageAnswers('no json here', QUESTIONS).ok).toBe(false);
  });

  test('prose braces before the real object do not derail parsing', () => {
    const raw =
      'The set {a, b} is not JSON. {"what_does": null, "offerings": ["Care"]}';
    const parsed = parsePageAnswers(raw, QUESTIONS);
    expect(parsed.ok).toBe(true);
  });

  test('an earlier valid-but-wrong object does not shadow the real answer', () => {
    // The model prefaces its reply with a small JSON example. First-parseable
    // would return {"note": ...}, fail the schema, and wrongly report failure.
    const raw =
      'For instance {"note": "reply with keys"}, here it is:\n' +
      '{"what_does": "Provides home care.", "offerings": ["Home care"]}';
    expect(parsePageAnswers(raw, QUESTIONS)).toEqual({
      ok: true,
      answers: { what_does: 'Provides home care.', offerings: ['Home care'] },
    });
  });
});
