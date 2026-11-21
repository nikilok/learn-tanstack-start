// The client side of asking: one token per document, minted the first time
// the offer would show or on the first ask, and replaced once when refused.
// Pure apart from the injected calls.

import type { SearchUrlParams } from '@ss/search-filters';

import { laterCooldown, toldCooldown } from './cooldown';

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
 * A device told to wait out a cooldown, by the mint, by a call or by the
 * page (`holdUntil`: a wait kept for the device, or told another tab), is not
 * asked about again until the wait is over. One check stands before
 * everything the document would send or say (`gate`), read in the same turn
 * as what it guards: every call in between answers with the latest wait
 * held, and the first one after it mints afresh.
 */
export function createAskLoader(
  mint: Mint,
  plan: Plan,
  rank: Rank,
  now: () => number = Date.now,
) {
  // The mint this document holds: in flight, or answered with a token or with nothing. It goes with every wait held.
  let current: Promise<AskMintResponse> | null = null;
  // The latest wait a mint, a call or the page has named: the one every call is held to until it is over.
  let waiting: number | null = null;

  /** The wait held while it is still ahead: one that is over is forgotten as it is read. */
  const ahead = (): number | null => {
    if (waiting !== null && now() >= waiting) waiting = null;
    return waiting;
  };

  /** What stands before anything this document would send or say: the wait held, while one is ahead. */
  const gate = (): AskCooldown | null => {
    const until = ahead();
    return until === null ? null : { status: 'cooldown', until };
  };

  /** Holds the document to a wait still ahead, the later of it and one held already. The token goes with it, so the first call after the wait mints afresh. */
  const hold = (until: number): void => {
    if (now() >= until) return;
    waiting = laterCooldown(ahead(), until);
    current = null;
  };

  /** Holds the document to a wait the server has just named: never over as it is told, whatever this device's clock says (`toldCooldown`). */
  const told = (until: number): void => hold(toldCooldown(until, now()));

  const mintToken = (key: string) => {
    const minted = mint(key);
    current = minted;
    minted.catch(() => {
      if (current === minted) current = null;
    });
    return minted;
  };

  /**
   * A token to send with and the mint it came from, or why there is none.
   * While a wait is held no mint is started or joined, and one that throws
   * during a wait answers the wait. A wait the mint names is held; what a
   * mint that issued nothing means is its caller's to read through `gate`,
   * as a wait may be held by then.
   */
  const acquire = async (
    key: string,
  ): Promise<
    | { token: string; from: Promise<AskMintResponse> }
    | { status: 'off' }
    | AskCooldown
  > => {
    const held = gate();
    if (held) return held;
    const from = current ?? mintToken(key);
    let answer: AskMintResponse;
    try {
      answer = await from;
    } catch (error) {
      const during = gate();
      if (during) return during;
      throw error;
    }
    if (answer.token === null && answer.cooldown !== undefined)
      told(answer.cooldown);
    return answer.token === null ? OFF : { token: answer.token, from };
  };

  const prepare = async (key: string): Promise<AskOffer> => {
    const got = await acquire(key);
    // Read again as this resumes: a wait told since counts.
    return gate() ?? ('token' in got ? { status: 'open' } : got);
  };

  /** Runs `call` with the document's token, replacing a refused one once; off when nothing is issued or the replacement is refused too. */
  const withToken = async <T extends Refusable>(
    key: string,
    call: (token: string) => Promise<T>,
  ): Promise<Admitted<T> | { status: 'off' } | AskCooldown> => {
    for (let replaced = false; ; replaced = true) {
      const got = await acquire(key);
      // Read here, with nothing awaited before the call is sent: a wait told since the token was read counts.
      const held = gate();
      if (held) return held;
      if (!('token' in got)) return got;
      const answer = await call(got.token);
      if (answer.status === 'cooldown') {
        told((answer as unknown as AskCooldown).until);
        return gate() ?? (answer as Admitted<T>);
      }
      if (answer.status !== 'denied') return answer as Admitted<T>;
      // A refused token. A wait told meanwhile is the answer; else it is replaced, once.
      const during = gate();
      if (during) return during;
      if (replaced) return OFF;
      // Another call may already have replaced it.
      if (current === got.from) current = null;
    }
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
