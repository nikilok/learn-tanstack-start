// What every ask call passes before the judge is reached, in one order for
// the mint, the plan and each further slice: who is asking, the token, the
// lists, the token budget, the browser check. The cheap checks come first and
// the billed one last, and an ask admitted is charged what it used once it
// has been answered. Pure: api/ask.ts supplies what each step reads.

import type { BrowserVerdict } from '../device/browser-check.server';
import type { AskStanding } from './access.server';
import { type Held, minimumCharge, statementFailure } from './allowance.server';

/** What the steps read, swapped out in tests. */
export type AdmissionDeps = {
  /** Who the request asks as (lib/ask/access.server). */
  standing: () => Promise<AskStanding>;
  /** Whether a token is a live one issued for the key (lib/device/token.server). */
  tokenMatches: (token: string, key: string) => boolean;
  /** Whether the key is on a list of refused devices (lib/device/suspended.server). */
  listed: (key: string) => Promise<boolean>;
  /** The tokens a device's asks may use before its cooldown; null when none is set (lib/ask/allowance.server). */
  budget: () => number | null;
  /** When a waiting device may ask again; null when it is not waiting. */
  cooling: (key: string) => Promise<number | null>;
  /** Admits one ask on a hold against the device's budget, or says when it may ask again. */
  hold: (key: string, budget: number) => Promise<Held>;
  /** Replaces an admitted ask's hold with the tokens it is charged. */
  settle: (key: string, charge: number, budget: number) => Promise<void>;
  /** The browser check's verdict on the request (lib/device/browser-check.server). */
  verdict: () => Promise<BrowserVerdict | 'unchecked'>;
};

/** What a mint is answered with: a token to issue, nothing for a request that may not ask at all (`nobody`) or one refused, or the time a waiting device may ask again. */
export type MintAdmission =
  | { status: 'issue' }
  | { status: 'nobody' }
  | { status: 'refused' }
  | { status: 'cooldown'; until: number };

/**
 * Charges an admitted ask the tokens it used, once it has been answered or
 * has failed: never less than the least an ask is charged, and only the
 * first time it is called. Never throws: nothing is owed to an ask whose
 * charge could not be written, as its hold then stands in for it.
 */
export type Charge = (used: number) => Promise<void>;

/** What a plan or a further slice is answered with before any judging: admitted, with the charge to settle afterwards; refused; told when the device may ask again; or told nothing could decide it right now. */
export type Admission =
  | { status: 'admitted'; charge: Charge }
  | { status: 'denied' }
  | { status: 'cooldown'; until: number }
  | { status: 'unavailable' };

const DENIED: Admission = { status: 'denied' };
const UNAVAILABLE: Admission = { status: 'unavailable' };

/** The charge of an ask no budget is kept for: the owner's, or a local run's without one. */
const UNCHARGED: Charge = async () => {};

/**
 * The budget a visitor asks under: the one set, which a public visitor must
 * have (`missing` without it, and said so, so asking never opens to all
 * unmetered); a local run may go without.
 */
function budgetFor(
  standing: 'local' | 'public',
  deps: AdmissionDeps,
): number | null | 'missing' {
  const budget = deps.budget();
  if (budget !== null || standing === 'local') return budget;
  console.error('[ask] ASK_DAILY_TOKENS not set');
  return 'missing';
}

/** Settles one hold at a charge, the first time it is called; a charge that cannot be written is said and left. */
function settling(
  key: string,
  budget: number,
  deps: AdmissionDeps,
): (charge: number) => Promise<void> {
  let settled = false;
  return async (charge) => {
    if (settled) return;
    settled = true;
    try {
      await deps.settle(key, charge, budget);
    } catch (error) {
      console.error(
        '[ask] usage could not be settled:',
        statementFailure(error),
      );
    }
  };
}

/**
 * Whether a device key is issued a token. A request that may not ask is
 * `nobody` before anything else is read. A listed key is refused, the
 * owner's too. A visitor's device that is waiting out a cooldown is told
 * when it ends, before the browser check is asked; a wait that cannot be
 * read is left for the ask's own hold to decide. A client the check names
 * automated is refused whatever `BROWSER_CHECK_ENFORCE` says; a check that
 * could not run still issues, as each ask is checked again. A mint is
 * charged nothing.
 */
export async function admitMint(
  key: string,
  deps: AdmissionDeps,
): Promise<MintAdmission> {
  const standing = await deps.standing();
  if (standing === null) return { status: 'nobody' };
  if (await deps.listed(key)) return { status: 'refused' };
  if (standing === 'owner') return { status: 'issue' };
  const budget = budgetFor(standing, deps);
  if (budget === 'missing') return { status: 'refused' };
  if (budget !== null) {
    let until: number | null = null;
    try {
      until = await deps.cooling(key);
    } catch (error) {
      console.error('[ask] usage could not be read:', statementFailure(error));
    }
    if (until !== null) return { status: 'cooldown', until };
  }
  const verdict = await deps.verdict();
  return verdict === 'person' || verdict === 'unchecked'
    ? { status: 'issue' }
    : { status: 'refused' };
}

/**
 * Whether a plan or a further slice goes to the judge, for a device key
 * presenting a token. A request that may not ask is `denied` before anything
 * else is read; so is a token not issued for the key (`onToken` runs once
 * one is, for work worth starting beside the remaining checks) and a listed
 * key. The owner is then admitted, uncharged.
 *
 * A visitor's ask is admitted on a hold against the device's token budget,
 * taken before the billed check: a device waiting out a cooldown is told
 * when it ends, and an ask whose hold cannot be written is `unavailable`, so
 * none is answered unmetered. Last, only a browser the check names a person's
 * is admitted, whatever `BROWSER_CHECK_ENFORCE` says. A client it names
 * automated is `denied` and charged the least an ask costs; a check that
 * could not run is `unavailable` and charged nothing.
 *
 * The caller of an admitted ask owes it one `charge`, with the tokens the
 * ask used, however the ask ended.
 */
export async function admitAsk(
  key: string,
  token: string,
  deps: AdmissionDeps,
  onToken: () => void = () => {},
): Promise<Admission> {
  const standing = await deps.standing();
  if (standing === null) return DENIED;
  if (!deps.tokenMatches(token, key)) return DENIED;
  onToken();
  if (await deps.listed(key)) return DENIED;
  if (standing === 'owner') return { status: 'admitted', charge: UNCHARGED };
  const budget = budgetFor(standing, deps);
  if (budget === 'missing') return DENIED;
  if (budget === null) {
    const verdict = await deps.verdict();
    if (verdict === 'person') return { status: 'admitted', charge: UNCHARGED };
    return verdict === 'unchecked' ? UNAVAILABLE : DENIED;
  }
  let held: Held;
  try {
    held = await deps.hold(key, budget);
  } catch (error) {
    console.error('[ask] usage could not be counted:', statementFailure(error));
    return UNAVAILABLE;
  }
  if (!held.admitted) return { status: 'cooldown', until: held.until };
  const settle = settling(key, budget, deps);
  const least = minimumCharge(budget);
  const verdict = await deps.verdict();
  if (verdict === 'unchecked') {
    await settle(0);
    return UNAVAILABLE;
  }
  if (verdict !== 'person') {
    await settle(least);
    return DENIED;
  }
  return {
    status: 'admitted',
    charge: (used) => settle(Math.max(used, least)),
  };
}
