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

import { parseFirstJsonObject } from '../../../scripts/lib/agent-action';
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

/** Token cost of the composed ask before any page text enters it. */
export function askOverheadTokens(questions: ProfileQuestion[]): number {
  return estimateTokens(buildAskPrompt(questions, 'x'.repeat(URL_DISPLAY_MAX), ''));
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

/**
 * The canonical string question_hash is computed over — everything that
 * shapes the ask. Deliberately wider than the plan's "prompt text": kind
 * picks the answer shape and intent aims the model, so editing either must
 * mark rows stale exactly as a prompt edit does. sort and slug are excluded —
 * reordering questions or renaming identity is not a reason to re-extract a
 * population. Callers store sha256 of this string.
 */
export function askHashInput(question: ProfileQuestion): string {
  return `${question.kind}\n${question.prompt}\n${question.intent}`;
}

export type ParsedAnswers =
  | { ok: true; answers: PageAnswers }
  | { ok: false; error: string };

/**
 * Schema-validate one model response against the question set. Strict: every
 * declared key present with its declared shape, or the whole response is a
 * failure — the caller retries once and then records status='error'.
 */
export function parsePageAnswers(
  raw: string,
  questions: ProfileQuestion[],
): ParsedAnswers {
  const parsed = parseFirstJsonObject(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'no JSON object in response' };
  }
  const record = parsed as Record<string, unknown>;
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
