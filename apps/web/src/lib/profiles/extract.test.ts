import { describe, expect, test } from 'bun:test';

import { estimateTokens, truncateToTokenBudget } from './clean';
import {
  askOverheadTokens,
  assertAskFits,
  buildAskPrompt,
  MIN_PAGE_BUDGET_TOKENS,
  OUTPUT_HEADROOM_TOKENS,
  overflowRetryBudget,
  pageTextBudget,
  parsePageAnswers,
  parseTokenOverflow,
  type ProfileQuestion,
  shrinkBudgetForOverflow,
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

  test('an undeclared extra key fails the response', () => {
    // 'Exactly these keys' is the contract; extra metadata means the model
    // wandered off the instructions and earns the retry, not acceptance.
    expect(
      parsePageAnswers(
        '{"what_does": "Cares.", "offerings": [], "confidence": 0.9}',
        QUESTIONS,
      ).ok,
    ).toBe(false);
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

describe('token overflow recovery', () => {
  test('the real CI failure parses, shrinks, and refits', () => {
    // The real CI failure (run 31504617373), Playwright wrapper included.
    const message =
      'evaluate: Error: Input token ids are too long. Exceeding the maximum ' +
      'number of tokens allowed: 10838 >= 8192\n' +
      '    at DefaultErrorReporter (http://127.0.0.1:49447/core/wasm/litertlm_wasm_internal.js:8016:9)';
    expect(parseTokenOverflow(message)).toEqual({
      actual: 10838,
      allowed: 8192,
    });
    // 31.5k chars overfills the char cap, so the base stays the budget.
    const next = overflowRetryBudget(7363, 'x'.repeat(31_502), 10838, 8192);
    expect(next).toBe(5008); // pinned by the live replay
    // Refit: retry = overhead + page×ratio, real overhead bounded at 2× its
    // estimate; scaling the WHOLE count by the ratio would understate it.
    const ratio = next / 7363;
    const overheadCeiling = 2 * askOverheadTokens(QUESTIONS);
    expect(overheadCeiling + (10838 - overheadCeiling) * ratio).toBeLessThan(
      8192,
    );
    expect(next).toBeGreaterThan(MIN_PAGE_BUDGET_TOKENS);
  });

  test('short dense page: the shrink base is the text actually sent', () => {
    // 21,600 chars at ~2.7 chars/token fits the char cap yet overflows the
    // window; rescaling the nominal budget would rebuild the identical prompt.
    const text = 'x'.repeat(21_600);
    const next = overflowRetryBudget(7363, text, 8330, 8192);
    expect(next).toBeLessThan(estimateTokens(text));
    expect(truncateToTokenBudget(text, next)).not.toBe(text);
    expect(next).toBeGreaterThan(MIN_PAGE_BUDGET_TOKENS);
  });

  test('boundary-cut page: the base is the sent text, not the full page', () => {
    // Last word boundary far below the char cap: the sent text is much
    // shorter than the budget implies, and a budget-based rescale can leave
    // the next cut at the same boundary, resending it verbatim.
    const full = `${'word '.repeat(3_520)}${'x'.repeat(20_000)}`;
    const sent = truncateToTokenBudget(full, 7363);
    expect(sent.length).toBeLessThan(7363 * 4 * 0.7);
    const next = overflowRetryBudget(7363, sent, 8330, 8192);
    expect(next).toBeLessThan(estimateTokens(sent));
    expect(truncateToTokenBudget(full, next)).not.toBe(sent);
  });

  test('overflow parsing rejects lookalikes and non-overflow pairs', () => {
    expect(parseTokenOverflow('evaluate: Error: WebGPU device lost')).toBe(
      null,
    );
    expect(parseTokenOverflow('Input token ids are too long, honest')).toBe(
      null,
    );
    expect(
      parseTokenOverflow(
        'Input token ids are too long. Exceeding the maximum number of tokens allowed: 0 >= 8192',
      ),
    ).toBe(null);
    // A pair that is not actual > allowed would rescale the budget UP.
    expect(
      parseTokenOverflow(
        'Input token ids are too long. Exceeding the maximum number of tokens allowed: 8192 >= 10838',
      ),
    ).toBe(null);
  });

  test('shrinking always makes strict progress on a positive budget', () => {
    // A one-token overflow must still shrink, or the retry loops in place.
    expect(shrinkBudgetForOverflow(1000, 8193, 8192)).toBeLessThan(1000);
    expect(shrinkBudgetForOverflow(0, 10838, 8192)).toBe(0);
    expect(shrinkBudgetForOverflow(1000, 0, 8192)).toBe(0);
  });
});
