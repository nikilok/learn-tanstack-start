/**
 * The reduce side of profiles extraction: fold per-page candidate answers
 * into one answer per question. Deterministic code, never a model call —
 * cross-document synthesis is exactly where a small model is weakest, so
 * composition lives here where it is testable. Provenance falls out free:
 * every candidate arrives tied to the page that produced it.
 */

import type { PageAnswers, ProfileQuestion, QuestionKind } from './extract';

/** One page's parsed answers, tied to where they came from. */
export type PageCandidate = {
  path: string;
  url: string;
  answers: PageAnswers;
};

export type MergedAnswer =
  | { kind: 'prose'; status: 'ok'; answer: string; sourceUrls: string[] }
  | { kind: 'list'; status: 'ok'; items: string[]; sourceUrls: string[] }
  | { kind: QuestionKind; status: 'insufficient_content'; sourceUrls: [] };

/** Union cap so one runaway response cannot bloat an answer row. */
export const MAX_LIST_ITEMS = 50;

/**
 * Where a prose answer is most likely to be the company's own account of
 * itself: about > home > services > everything else. Ties keep caller order.
 */
function pagePriority(path: string): number {
  const key = path.toLowerCase();
  if (key.includes('about')) return 0;
  if (key === '') return 1;
  if (key.includes('service') || key.includes('what-we-do')) return 2;
  return 3;
}

/** Dedupe key for list items: case, whitespace and trailing punctuation. */
function normaliseItem(item: string): string {
  return item
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim();
}

/**
 * Fold page candidates into per-question answers. Prose takes the first
 * non-null by page priority; lists union across pages with normalised dedupe,
 * first-seen wording kept. A question no page answered is
 * 'insufficient_content' — always preferred over a guess.
 */
export function mergeAnswers(
  questions: ProfileQuestion[],
  candidates: PageCandidate[],
): Record<string, MergedAnswer> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        pagePriority(a.candidate.path) - pagePriority(b.candidate.path) ||
        a.index - b.index,
    )
    .map((entry) => entry.candidate);

  const merged: Record<string, MergedAnswer> = {};
  for (const question of questions) {
    if (question.kind === 'prose') {
      const found = ordered.find(
        (candidate) => typeof candidate.answers[question.slug] === 'string',
      );
      merged[question.slug] = found
        ? {
            kind: 'prose',
            status: 'ok',
            answer: found.answers[question.slug] as string,
            sourceUrls: [found.url],
          }
        : { kind: 'prose', status: 'insufficient_content', sourceUrls: [] };
      continue;
    }

    const items: string[] = [];
    const seen = new Set<string>();
    const sourceUrls: string[] = [];
    for (const candidate of ordered) {
      const value = candidate.answers[question.slug];
      if (!Array.isArray(value) || value.length === 0) continue;
      sourceUrls.push(candidate.url);
      for (const item of value) {
        const key = normaliseItem(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (items.length < MAX_LIST_ITEMS) items.push(item);
      }
    }
    merged[question.slug] =
      items.length > 0
        ? { kind: 'list', status: 'ok', items, sourceUrls }
        : { kind: 'list', status: 'insufficient_content', sourceUrls: [] };
  }
  return merged;
}
