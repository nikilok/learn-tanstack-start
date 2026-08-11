/**
 * HTML → the cleaned readable text the profiles corpus stores, and the token
 * budget that keeps any one page inside a composed ask. Pure.
 *
 * Builds on visibleText (script/style/comment handling, entity decoding,
 * inline-tag fusion) and strips structural chrome first, because tag
 * boundaries are gone after it runs. Callers persist only what this returns —
 * raw HTML is never stored.
 */

import { visibleText } from '../websites/extract';

/**
 * Planning ratio for English prose under Gemma's tokenizer. An estimate, not a
 * count: the step that composes the ask must keep its own headroom and assert
 * the full prompt fits the window.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Comments and script/style bodies, removed BEFORE the boilerplate pass. This
 * ordering is load-bearing: a boilerplate open tag hidden inside a comment
 * (`<!-- <form> …`) or a script string would otherwise pair with a later real
 * close tag, and BOILERPLATE would delete every genuine line between them —
 * the exact commented-out-open-tag bug visibleText's own docstring records.
 * The `|$` fallbacks mirror visibleText (which re-runs these harmlessly after
 * us): a truncated comment/script at the 2MB cap collapses rather than
 * surviving as a phantom open.
 */
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
const SCRIPT_STYLE = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Structural chrome that is navigation, not content. No `|$` fallback on the
 * close tag, deliberately: a genuinely unclosed <header> must not swallow the
 * rest of the document the way a truncated <script> is allowed to — an
 * unmatched open is left for visibleText's tag strip, keeping the content.
 *
 * The `{0,BOILERPLATE_MAX}?` bound stops an unclosed open tag from scanning to
 * end-of-string: without it every unmatched <nav>/<header> triggers an
 * O(length) lazy walk to EOF, and a page full of them is O(opens × length).
 * A real chrome block never approaches this ceiling.
 */
const BOILERPLATE_MAX = 200_000;
const BOILERPLATE = new RegExp(
  `<(nav|footer|header|aside|form|select|noscript|iframe|svg|dialog|template)\\b[^>]*>[\\s\\S]{0,${BOILERPLATE_MAX}}?</\\1\\s*>`,
  'gi',
);

/** Cleaned readable text for one fetched page. */
export function cleanPageText(html: string): string {
  // Order matters: kill comments and scripts, THEN chrome, THEN visibleText.
  const stripped = html
    .replace(COMMENTS, '\n')
    .replace(SCRIPT_STYLE, '\n')
    .replace(BOILERPLATE, '\n');
  return visibleText(stripped)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Planning estimate of the tokens `text` costs inside a prompt. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Hard-cap text to a token budget, cutting at a line or word boundary when one
 * exists in the back half. estimateTokens of the result never exceeds budget.
 */
export function truncateToTokenBudget(
  text: string,
  budgetTokens: number,
): string {
  // Floor the budget first: 0.5 tokens must yield nothing, not two chars
  // that estimate back to a whole token over budget.
  const maxChars = Math.floor(budgetTokens) * CHARS_PER_TOKEN;
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  return (breakAt > maxChars / 2 ? slice.slice(0, breakAt) : slice).trimEnd();
}
