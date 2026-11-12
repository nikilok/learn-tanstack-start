// The client side of asking: one token per document, minted the first time
// the offer would show or on the first ask, and replaced once when refused.
// Pure apart from the injected calls.

import type { SearchUrlParams } from '@ss/search-filters';

/** Why a plan is empty when it is, as the engine reports it: the wire contract, restated here so the browser never depends on the engine's types. */
export type EmptyReason = 'none' | 'name' | 'beyond' | 'unmatched';

/** What pathway B found for the span: the companies at or over the closest band, by id in rank order, matches first, as the slices they were judged in (lib/ask/tranches), and the offset of the slice to judge next, null once the shortlist ran out. Ids only: no names, no probabilities, no counts. */
export type AskRanking = {
  span: string;
  tranches: string[][];
  next: number | null;
};

/** planSearch's answer: the plan (with pathway B's ranking when the text said what the organisations do), or a refusal of what was presented, or a failure to answer. */
export type AskPlanResponse =
  | {
      status: 'ok';
      filters: SearchUrlParams;
      reason: EmptyReason;
      ranking: AskRanking | null;
    }
  | { status: 'denied' }
  | { status: 'unavailable' };

/** rankMore's answer: one more judged slice of the span's shortlist and where the walk goes next, or a refusal of what was presented, or a failure to answer. */
export type AskMoreResponse =
  | { status: 'ok'; ranked: string[]; next: number | null }
  | { status: 'denied' }
  | { status: 'unavailable' };

/** What one ask came to: a plan; `off` when this document may not ask at all; `unavailable` when nothing could answer right now. */
export type AskOutcome =
  | Extract<AskPlanResponse, { status: 'ok' }>
  | { status: 'off' }
  | { status: 'unavailable' };

/** What one further slice came to: the slice; `off` when this document may not ask at all; `unavailable` when nothing could judge it right now. */
export type AskMoreOutcome =
  | Extract<AskMoreResponse, { status: 'ok' }>
  | { status: 'off' }
  | { status: 'unavailable' };

type Mint = (key: string) => Promise<string | null>;

type Plan = (
  text: string,
  key: string,
  token: string,
  base: SearchUrlParams,
) => Promise<AskPlanResponse>;

type Rank = (
  span: string,
  key: string,
  token: string,
  params: SearchUrlParams,
  offset: number,
) => Promise<AskMoreResponse>;

type Refusable = { status: string };
type Admitted<T extends Refusable> = Exclude<T, { status: 'denied' }>;

/**
 * One token per document. `prepare` mints it and says whether this document
 * may ask at all, so the offer is only shown where it can be taken; `ask`
 * and `more` reuse it, replace it once when refused and retry, and read a
 * second refusal, or a mint that issues nothing, as `off`. The mint in flight
 * is what is shared, so overlapping callers mint once and a refusal is learnt
 * once; a mint that throws is dropped so the next call tries again, and a
 * call that throws rejects with the token kept, since the token was not
 * what failed.
 */
export function createAskLoader(mint: Mint, plan: Plan, rank: Rank) {
  let current: Promise<string | null> | null = null;

  const mintToken = (key: string) => {
    const minted = mint(key);
    current = minted;
    minted.catch(() => {
      if (current === minted) current = null;
    });
    return minted;
  };

  const prepare = async (key: string): Promise<boolean> =>
    (await (current ?? mintToken(key))) !== null;

  /** Runs `call` with the document's token, replacing a refused one once; off when nothing is issued or the replacement is refused too. */
  const withToken = async <T extends Refusable>(
    key: string,
    call: (token: string) => Promise<T>,
  ): Promise<Admitted<T> | { status: 'off' }> => {
    const used = current ?? mintToken(key);
    const first = await used;
    if (first === null) return { status: 'off' };
    const answer = await call(first);
    if (answer.status !== 'denied') return answer as Admitted<T>;
    // Another call may already have replaced the refused token.
    if (current === used) current = null;
    const fresh = await (current ?? mintToken(key));
    if (fresh === null) return { status: 'off' };
    const retried = await call(fresh);
    return retried.status === 'denied'
      ? { status: 'off' }
      : (retried as Admitted<T>);
  };

  const ask = (
    text: string,
    key: string,
    base: SearchUrlParams = {},
  ): Promise<AskOutcome> =>
    withToken(key, (token) => plan(text, key, token, base));

  const more = (
    span: string,
    key: string,
    params: SearchUrlParams,
    offset: number,
  ): Promise<AskMoreOutcome> =>
    withToken(key, (token) => rank(span, key, token, params, offset));

  return { prepare, ask, more };
}
