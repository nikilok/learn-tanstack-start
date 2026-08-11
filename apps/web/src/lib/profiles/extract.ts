/**
 * The map side of profiles extraction: one ask carries every active question
 * over one page's text, producing per-page candidate answers. Pure — the
 * model call is injected by the caller; merge.ts owns cross-page composition,
 * because a small model reads one page well and synthesizes across documents
 * badly.
 *
 * The grounding invariant lives in the prompt and the parser together: the
 * model answers only from the supplied text, "the page does not say" is a
 * first-class outcome (null / []), and anything that fails schema validation
 * is a parse failure for the caller to retry once — never a loosely-accepted
 * answer.
 */

import { scanJsonObjects } from '../../../scripts/lib/agent-action';
import { estimateTokens } from './clean';

export type QuestionKind = 'prose' | 'list';

/** One row of profile_questions, as the ask consumes it. */
export type ProfileQuestion = {
  slug: string;
  prompt: string;
  kind: QuestionKind;
  intent: string;
  sort: number;
};

/** One page's candidate answers: prose → string|null, list → string[]. */
export type PageAnswers = Record<string, string | null | string[]>;

export const SYSTEM_PROMPT =
  'You extract facts from one page of a company website. You answer only ' +
  'from the page text you are given, never from outside knowledge, and you ' +
  'never guess. Respond with a single JSON object only — no prose, no code ' +
  'fences.';

/** Decode-side allowance the composed ask must leave inside the window. */
export const OUTPUT_HEADROOM_TOKENS = 512;

/** Below this per-page budget an ask cannot carry useful text; fail loudly. */
export const MIN_PAGE_BUDGET_TOKENS = 500;

/** Longest URL echoed into a prompt; longer ones are elided, not load-bearing. */
const URL_DISPLAY_MAX = 200;

/** The JSON shape line, derived from the question set so it cannot drift. */
function shapeLine(questions: ProfileQuestion[]): string {
  const keys = questions
    .map(
      (question) =>
        `"${question.slug}": ${question.kind === 'prose' ? 'string | null' : 'string[]'}`,
    )
    .join(', ');
  return `{ ${keys} }`;
}

/** Compose the single ask for one page. Deterministic, sort-order questions. */
export function buildAskPrompt(
  questions: ProfileQuestion[],
  pageUrl: string,
  pageText: string,
): string {
  const ordered = [...questions].sort((a, b) => a.sort - b.sort);
  const numbered = ordered
    .map(
      (question, index) =>
        `${index + 1}. ${question.slug} (${question.kind}): ${question.prompt}\n   Intent: ${question.intent}`,
    )
    .join('\n');
  return `You are reading one page from a company's website: ${pageUrl.slice(0, URL_DISPLAY_MAX)}

Answer these questions using ONLY the PAGE TEXT below.
${numbered}

Reply with ONE JSON object, exactly these keys:
${shapeLine(ordered)}
- prose questions: a concise answer in the page's own words, or null when the page does not say.
- list questions: short item names taken from the page, or [] when the page lists none.
Never state anything that is not in the PAGE TEXT.

PAGE TEXT:
${pageText}`;
}

/** Token cost of the composed ask before any page text enters it. The system
 *  prompt rides in the same request, so it spends the same context window. */
export function askOverheadTokens(questions: ProfileQuestion[]): number {
  return (
    estimateTokens(SYSTEM_PROMPT) +
    estimateTokens(buildAskPrompt(questions, 'x'.repeat(URL_DISPLAY_MAX), ''))
  );
}

/** Per-page text budget for a given context window; can be non-positive. */
export function pageTextBudget(
  questions: ProfileQuestion[],
  contextTokens: number,
): number {
  return contextTokens - askOverheadTokens(questions) - OUTPUT_HEADROOM_TOKENS;
}

/**
 * The runner's startup assertion: the question set is data, so the fit is
 * checked against the live table every run rather than assumed. Returns the
 * per-page budget; throws when the composed ask cannot carry useful text.
 */
export function assertAskFits(
  questions: ProfileQuestion[],
  contextTokens: number,
): number {
  const budget = pageTextBudget(questions, contextTokens);
  if (budget < MIN_PAGE_BUDGET_TOKENS) {
    throw new Error(
      `composed ask leaves ${budget} tokens for page text ` +
        `(context ${contextTokens}, overhead ${askOverheadTokens(questions)}, ` +
        `headroom ${OUTPUT_HEADROOM_TOKENS}); need ${MIN_PAGE_BUDGET_TOKENS}. ` +
        'Shard the question set before raising the window.',
    );
  }
  return budget;
}

/** Slack applied when re-truncating after a real-tokenizer overflow. */
export const OVERFLOW_SHRINK_MARGIN = 0.9;

/** Shrink retries per page before the overflow is treated as a failure. */
export const MAX_OVERFLOW_SHRINKS = 2;

/**
 * Read the engine's measured token counts out of a window-overflow error.
 * The budget maths runs on estimated tokens; the engine judges the composed
 * ask with its real tokenizer, and dense non-prose text (URLs, menus,
 * numbers) can tokenize far under 4 chars/token. The overflow message
 * carries the real count, which is exactly the correction the retry needs.
 */
export function parseTokenOverflow(
  message: string,
): { actual: number; allowed: number } | null {
  const match = /Input token ids are too long[\s\S]*?(\d+)\s*>=\s*(\d+)/.exec(
    message,
  );
  if (!match) return null;
  const actual = Number(match[1]);
  const allowed = Number(match[2]);
  if (!Number.isFinite(actual) || !Number.isFinite(allowed) || actual <= 0) {
    return null;
  }
  return { actual, allowed };
}

/** Rescale an estimated page budget by the engine's measured ratio, with
 *  margin. Non-positive means the page cannot be made to fit. */
export function shrinkBudgetForOverflow(
  budget: number,
  actual: number,
  allowed: number,
): number {
  if (actual <= 0) return 0;
  return Math.floor(budget * (allowed / actual) * OVERFLOW_SHRINK_MARGIN);
}

/**
 * The canonical string question_hash is computed over — everything that
 * shapes the ask. Deliberately wider than the plan's "prompt text": kind
 * picks the answer shape and intent aims the model, so editing either must
 * mark rows stale exactly as a prompt edit does. sort and slug are excluded —
 * reordering questions or renaming identity is not a reason to re-extract a
 * population. Callers store sha256 of this string.
 */
export function askHashInput(question: ProfileQuestion): string {
  // The system prompt shapes every answer, so it is part of each question's
  // fingerprint. Slug and sort stay excluded on purpose: staleness is
  // per-question (editing one question re-asks one question, not the whole
  // corpus), and composition-order effects are accepted noise under that
  // cost model. JSON framing keeps field boundaries unambiguous — newlines
  // are legal inside prompts, so a bare join could hash two different
  // questions identically.
  return JSON.stringify([
    SYSTEM_PROMPT,
    question.kind,
    question.prompt,
    question.intent,
  ]);
}

export type ParsedAnswers =
  | { ok: true; answers: PageAnswers }
  | { ok: false; error: string };

/** Validate one candidate object against the question schema. Strict: every
 *  declared key present with its declared shape, or a failure. */
function validateAnswers(
  parsed: unknown,
  questions: ProfileQuestion[],
): ParsedAnswers {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  // The prompt demands EXACTLY the declared keys; an undeclared extra means
  // the model deviated from instructions, which is grounds for the retry.
  const declared = new Set(questions.map((question) => question.slug));
  for (const key of Object.keys(record)) {
    if (!declared.has(key)) {
      return { ok: false, error: `undeclared key "${key}"` };
    }
  }
  const answers: PageAnswers = {};
  for (const question of questions) {
    if (!(question.slug in record)) {
      return { ok: false, error: `missing key "${question.slug}"` };
    }
    const value = record[question.slug];
    if (question.kind === 'prose') {
      if (value === null) {
        answers[question.slug] = null;
        continue;
      }
      if (typeof value !== 'string') {
        return { ok: false, error: `"${question.slug}" must be string | null` };
      }
      const trimmed = value.trim();
      answers[question.slug] = trimmed ? trimmed : null;
      continue;
    }
    if (!Array.isArray(value)) {
      return { ok: false, error: `"${question.slug}" must be an array` };
    }
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        return { ok: false, error: `"${question.slug}" items must be strings` };
      }
      const trimmed = item.trim();
      if (trimmed) items.push(trimmed);
    }
    answers[question.slug] = items;
  }
  return { ok: true, answers };
}

/**
 * Schema-validate a model response against the question set. Walks every
 * parseable object and returns the FIRST that validates — a leading prose
 * example (`for instance {"note": 1}`) must not shadow the real answer object
 * and turn a valid response into a failure. The caller retries once and then
 * records status='error'.
 */
export function parsePageAnswers(
  raw: string,
  questions: ProfileQuestion[],
): ParsedAnswers {
  let lastError = 'no JSON object in response';
  for (const candidate of scanJsonObjects(raw)) {
    const result = validateAnswers(candidate, questions);
    if (result.ok) return result;
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}
