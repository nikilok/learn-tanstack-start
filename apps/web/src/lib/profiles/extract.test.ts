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
  isNonAnswer,
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

  test('a reply about the page instead of the company is "the page does not say"', () => {
    // Replies the corpus held under status ok before the rule (2026-10-10).
    for (const reply of [
      'The provided text does not state what the company does.',
      'The page does not state what the company does.',
      'The text does not state what the company does in a single, concise paragraph defining its identity.',
      'The text provided does not contain a single paragraph describing what the company does.',
      "The provided text is largely placeholder text ('Lorem ipsum dolor sit amet') and does not contain a clear, one-paragraph identity of the business.",
      'The provided text is a navigation menu and links for a school website and does not contain a paragraph describing what the company does.',
      'The page does not provide a one-paragraph identity of the business.',
      'The provided text is a blog post about home truths about teeth cleaning and does not state the one-paragraph identity of the business.',
      'The provided text does not state what Care UK does.',
      'This page contains no description of the company.',
      'The content provided is insufficient to describe the company.',
      'The provided text is a blog post about planting the Albert roundabout.',
      'The provided text is a list of projects or publications associated with Kellenberger–White, including identity and strategy work.',
      'The provided text is a listing for a record, not a general description of the company’s business.',
      'The page that you are looking for either does not exist, has been removed, had the name changed or is temporarily unavailable.',
      'The page you are looking for cannot be found.',
      'The page is missing.',
      'The page was not found.',
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      'There is no information about what the company does.',
      'The provided text only lists navigation links.',
      'The provided text is a privacy policy.',
      'The website appears to be under construction.',
      'The provided text consists only of a cookie banner.',
      'The page is a contact form only.',
      'Not stated.',
      'Unfortunately, the provided text does not describe what the company does.',
      'The provided text for Acme Ltd. does not state what the company does.',
      'The provided text doesn’t state what the company does.',
      'The provided text is a cookie policy. It does not describe the company.',
      // Shapes the gap sweep of 2026-10-10 found unread.
      'The webpage does not describe the company.',
      'The web page is a 404 error page.',
      'The text does not identify the company.',
      'The page does not name the organisation.',
      'The page is a login screen.',
      'The page is mostly boilerplate.',
      'The page is a blog about gardening.',
    ]) {
      expect(isNonAnswer(reply)).toBe(true);
      const parsed = parsePageAnswers(
        JSON.stringify({ what_does: reply, offerings: [] }),
        QUESTIONS,
      );
      expect(parsed.ok && parsed.answers.what_does).toBe(null);
    }
  });

  test("a company's own account is never read as a non-answer, even when it mentions its site or says no", () => {
    for (const answer of [
      'Provides domiciliary care across Sussex.',
      'The website is the online home of Acme Ltd, a family-run bakery in Leeds.',
      'The company does not sell to the public; it supplies trade customers only.',
      'This text-processing firm builds document pipelines for publishers.',
      'The Page Agency is a recruitment consultancy for the legal sector.',
      'The Website People don’t just build websites, we build brands.',
      'The Information Lab is a data consultancy that does not outsource delivery.',
      'The site offers no-nonsense plumbing services across Kent.',
      'This website provides no-obligation quotes for boiler installations across Leeds.',
      'The website provides no-win no-fee personal injury representation.',
      'The content marketing agency has no in-house printing but partners with local presses.',
      'The site has no shortage of options for garden lovers, from bedding plants to tools.',
      'The information technology consultancy does not outsource its support desk.',
      'The content studio cannot be beaten on turnaround; it produces video for brands.',
      'This content marketing agency does not work with tobacco brands.',
      // Trades that share a word with a kind of page, or deny something
      // about their customers (gap sweep, 2026-10-10).
      'The website is a newsagent and convenience store in Hull.',
      'The site is a formwork contractor for the construction industry.',
      'This website is a news and media company covering Yorkshire.',
      'The website is a listed building consultancy.',
      'The site is a privacy consultancy helping firms with GDPR.',
      'The site is a cookie bakery in Leeds.',
      'The website is a form building tool for small businesses.',
      'The website is a link building agency.',
      'The site is a blog marketing agency for retailers.',
      'The website does not sell to businesses, only to the public.',
      'The site does not charge companies for listing their vacancies.',
      'The information technology firm does not tell clients what to buy.',
      // Live corpus, 2026-10-10: a charity's own account opening on a denial.
      'There is no known cure for MS - research is ongoing in this field however in the meantime symptom management is key.',
    ]) {
      expect(isNonAnswer(answer), answer).toBe(false);
    }
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
