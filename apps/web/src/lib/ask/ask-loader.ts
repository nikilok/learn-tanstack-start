// The client side of asking: one token per document, minted the first time
// the offer would show or on the first ask, and replaced once when refused.
// Pure apart from the injected calls.

import type { SearchUrlParams } from '@ss/search-filters';

import { laterCooldown } from './cooldown';

/** Why a plan is empty when it is, as the engine reports it: the wire contract, restated here so the browser never depends on the engine's types. */
export type EmptyReason = 'none' | 'name' | 'beyond' | 'unmatched';

/** What pathway B found for the span: the companies at or over the closest band, by id in rank order, matches first, as the slices they were judged in (lib/ask/tranches), the sector the question named (ranking every slice's order and cutting none; null when none, lib/ask/sector), and the offset of the slice to judge next, null once the shortlist ran out. Ids only: no names, no probabilities, no counts. */
export type AskRanking = {
  span: string;
  sector: string | null;
  tranches: string[][];
  next: number | null;
};

/** A device whose asks have used up its token budget, and when it may ask again (epoch milliseconds; lib/ask/cooldown). */
export type AskCooldown = { status: 'cooldown'; until: number };

/** The mint's answer: a token, or none, with the time a device waiting out a cooldown may ask again. */
export type AskMintResponse = { token: string | null; cooldown?: number };

/** planSearch's answer: the plan (with pathway B's ranking when the text said what the organisations do), or a refusal of what was presented, or a device told to wait, or a failure to answer. */
export type AskPlanResponse =
  | {
      status: 'ok';
      filters: SearchUrlParams;
      reason: EmptyReason;
      ranking: AskRanking | null;
    }
  | { status: 'denied' }
  | AskCooldown
  | { status: 'unavailable' };

/** rankMore's answer: one more judged slice of the span's shortlist and where the walk goes next, or a refusal of what was presented, or a device told to wait, or a failure to answer. */
export type AskMoreResponse =
  | { status: 'ok'; ranked: string[]; next: number | null }
  | { status: 'denied' }
  | AskCooldown
  | { status: 'unavailable' };

/** Whether this document may ask: `open`, `off` when it may not at all, or waiting out a cooldown. */
export type AskOffer = { status: 'open' } | { status: 'off' } | AskCooldown;

/** What one ask came to: a plan; `off` when this document may not ask at all; a cooldown to wait out; `unavailable` when nothing could answer right now. */
export type AskOutcome =
  | Extract<AskPlanResponse, { status: 'ok' }>
  | { status: 'off' }
  | AskCooldown
  | { status: 'unavailable' };

/** What one further slice came to: the slice; `off` when this document may not ask at all; a cooldown to wait out; `unavailable` when nothing could judge it right now. */
export type AskMoreOutcome =
  | Extract<AskMoreResponse, { status: 'ok' }>
  | { status: 'off' }
  | AskCooldown
  | { status: 'unavailable' };

type Mint = (key: string) => Promise<AskMintResponse>;

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
  sector: string | null,
) => Promise<AskMoreResponse>;

type Refusable = { status: string };
type Admitted<T extends Refusable> = Exclude<T, { status: 'denied' }>;

const OFF = { status: 'off' } as const;

/**
 * One token per document. `prepare` mints it and says whether this document
 * may ask at all, so the offer is only shown where it can be taken; `ask`
 * and `more` reuse it, replace it once when refused and retry, and read a
 * second refusal, or a mint that issues nothing, as `off`. The mint in flight
 * is what is shared, so overlapping callers mint once and a refusal is learnt
 * once; a mint that throws is dropped so the next call tries again, and a
 * call that throws rejects with the token kept, since the token was not
 * what failed.
 *
 * A device told to wait out a cooldown, by the mint or by a call, is not
 * asked about again until the wait is over: every call in between answers
 * with the cooldown, and the first one after it mints afresh. `holdUntil`
 * holds the document to a wait the page learnt elsewhere, one kept for the
 * device or told another tab, on the same terms.
 */
export function createAskLoader(
  mint: Mint,
  plan: Plan,
  rank: Rank,
  now: () => number = Date.now,
) {
  let current: Promise<AskMintResponse> | null = null;
  // The latest wait a mint, a call or the page has named, until it is over: the one every call is held to.
  let waiting: number | null = null;

  const mintToken = (key: string) => {
    const minted = mint(key);
    current = minted;
    minted.catch(() => {
      if (current === minted) current = null;
    });
    return minted;
  };

  /** Holds a wait that is still ahead, the later of it and one held already: one a mint named, or one the page learnt elsewhere (`holdUntil`). */
  const hold = (until: number): void => {
    if (now() < until) waiting = laterCooldown(waiting, until);
  };

  /**
   * A mint's answer as a call may act on it. A wait it names is held; and
   * while a wait held is still ahead, that wait is the answer, whatever this
   * one carries: a token, an earlier wait, or nothing at all.
   */
  const settled = (answer: AskMintResponse): AskMintResponse => {
    if (answer.token === null && answer.cooldown !== undefined)
      hold(answer.cooldown);
    return waiting !== null && now() < waiting
      ? { token: null, cooldown: waiting }
      : answer;
  };

  /** The mint to read: the wait held while one is still ahead, with none started or joined; else the mint this document holds, or a new one. */
  const minting = (key: string): Promise<AskMintResponse> =>
    waiting !== null && now() < waiting
      ? Promise.resolve({ token: null, cooldown: waiting })
      : (current ?? mintToken(key));

  /**
   * The mint this document holds and what it answered, minted when there is
   * none and afresh when every wait held is over. The answer is as it came:
   * its caller reads it through `settled` as it resumes, so a wait told in
   * between counts.
   */
  const held = async (key: string) => {
    const used = minting(key);
    const answer = await used;
    if (
      answer.token !== null ||
      answer.cooldown === undefined ||
      now() < answer.cooldown
    )
      return { used, answer };
    // The wait this answer named is over: it goes, a wait held that is over is forgotten, and the next mint starts afresh unless a later wait is held.
    if (current === used) current = null;
    if (waiting !== null && now() >= waiting) waiting = null;
    const fresh = minting(key);
    return { used: fresh, answer: await fresh };
  };

  /** What a mint that issued nothing means: a cooldown to wait out, or off. */
  const refusal = (answer: AskMintResponse): { status: 'off' } | AskCooldown =>
    answer.cooldown === undefined
      ? OFF
      : { status: 'cooldown', until: answer.cooldown };

  /** Remembers a cooldown a call named, the later of it and one already held, so nothing is sent until it is over. The token goes with it: the next call mints. */
  const wait = <T extends Refusable>(answer: T): T => {
    if (answer.status === 'cooldown') {
      waiting = laterCooldown(
        waiting,
        (answer as unknown as AskCooldown).until,
      );
      current = Promise.resolve({ token: null, cooldown: waiting });
    }
    return answer;
  };

  const prepare = async (key: string): Promise<AskOffer> => {
    const answer = settled((await held(key)).answer);
    return answer.token === null ? refusal(answer) : { status: 'open' };
  };

  /** Runs `call` with the document's token, replacing a refused one once; off when nothing is issued or the replacement is refused too. */
  const withToken = async <T extends Refusable>(
    key: string,
    call: (token: string) => Promise<T>,
  ): Promise<Admitted<T> | { status: 'off' } | AskCooldown> => {
    const { used, answer: minted } = await held(key);
    // Read here, with nothing awaited before the call is sent.
    const first = settled(minted);
    if (first.token === null) return refusal(first);
    const answer = await call(first.token);
    if (answer.status !== 'denied') return wait(answer) as Admitted<T>;
    // Another call may already have replaced the refused token. Read as the first was: a wait that has ended since gives way to a new mint.
    if (current === used) current = null;
    const fresh = settled((await held(key)).answer);
    if (fresh.token === null) return refusal(fresh);
    const retried = await call(fresh.token);
    return retried.status === 'denied' ? OFF : (wait(retried) as Admitted<T>);
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
    sector: string | null,
  ): Promise<AskMoreOutcome> =>
    withToken(key, (token) => rank(span, key, token, params, offset, sector));

  return { prepare, ask, more, holdUntil: hold };
}
