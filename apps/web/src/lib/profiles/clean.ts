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
 * Structural chrome that is navigation, not content. No `|$` fallback on the
 * close tag, deliberately: an unclosed <header> must not swallow the rest of
 * the document the way a truncated <script> is allowed to in visibleText —
 * an unmatched open is simply left for visibleText's tag strip, keeping the
 * content. Nested same-tag markup truncates at the first close; leftovers are
 * tag-stripped downstream.
 */
const BOILERPLATE =
  /<(nav|footer|header|aside|form|select|noscript|iframe|svg|dialog|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Cleaned readable text for one fetched page. */
export function cleanPageText(html: string): string {
  const text = visibleText(html.replace(BOILERPLATE, '\n'));
  return text
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
  const maxChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  return (breakAt > maxChars / 2 ? slice.slice(0, breakAt) : slice).trimEnd();
}
