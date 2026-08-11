/**
 * Row shaping for company_answers: one place maps an origin's extraction
 * outcome onto the stored columns, so the write factory stays a dumb
 * statement. Pure.
 *
 * The status rules carry the grounding invariant into storage:
 * 'insufficient_content' covers both "pages read, nothing said" and "origin
 * crawled, nothing readable" (empty source_urls closes the selection loop for
 * all-junk origins), while 'error' is reserved for the model failing schema
 * validation after its retry. A guess is never a state.
 */

import type { ProfileQuestion } from './extract';
import type { MergedAnswer } from './merge';

export type ExtractionOutcome =
  /** Pages were asked and the merge composed per-question results. */
  | { kind: 'merged'; merged: Record<string, MergedAnswer> }
  /** The origin has been crawled but holds no readable page text. */
  | { kind: 'no_readable_pages' }
  /** Readable pages existed but no response survived schema validation. */
  | { kind: 'model_failure' };

export type AnswerStatus = 'ok' | 'insufficient_content' | 'error';

/** One company_answers row, every stamp resolved; extracted_at is the DB's. */
export type AnswerRow = {
  companyNumber: string;
  questionSlug: string;
  questionHash: string;
  questionText: string;
  answer: string | null;
  items: string[] | null;
  sourceUrls: string[];
  identityEvidence: string;
  model: string;
  status: AnswerStatus;
};

export type AnswerStamps = {
  /** sha256 hex of askHashInput(question), per slug — the staleness key. */
  hashes: Map<string, string>;
  /** Model identity at extraction time. */
  model: string;
  /** Website evidence tier at extraction time. */
  identityEvidence: string;
};

/** Rows for one company from one origin-level extraction outcome. */
export function answerRows(
  companyNumber: string,
  questions: ProfileQuestion[],
  outcome: ExtractionOutcome,
  stamps: AnswerStamps,
): AnswerRow[] {
  return questions.map((question) => {
    const questionHash = stamps.hashes.get(question.slug);
    if (!questionHash) {
      throw new Error(`no ask hash computed for question "${question.slug}"`);
    }
    const base = {
      companyNumber,
      questionSlug: question.slug,
      questionHash,
      questionText: question.prompt,
      identityEvidence: stamps.identityEvidence,
      model: stamps.model,
    };
    if (outcome.kind === 'model_failure') {
      return {
        ...base,
        answer: null,
        items: null,
        sourceUrls: [],
        status: 'error' as const,
      };
    }
    const merged =
      outcome.kind === 'merged' ? outcome.merged[question.slug] : undefined;
    if (!merged || merged.status === 'insufficient_content') {
      return {
        ...base,
        answer: null,
        items: null,
        sourceUrls: [],
        status: 'insufficient_content' as const,
      };
    }
    return merged.kind === 'prose'
      ? {
          ...base,
          answer: merged.answer,
          items: null,
          sourceUrls: merged.sourceUrls,
          status: 'ok' as const,
        }
      : {
          ...base,
          answer: null,
          items: merged.items,
          sourceUrls: merged.sourceUrls,
          status: 'ok' as const,
        };
  });
}
