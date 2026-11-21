// What every ask call passes before the judge is reached, in one order for
// the mint, the plan and each further slice: who is asking, the token, the
// lists, the token budgets, the browser check. The cheap checks come first and
// the billed one last, and an ask admitted is charged what it used once it
// has been answered. Pure: api/ask.ts supplies what each step reads.

import type { BrowserVerdict } from '../device/browser-check.server';
import type { AskStanding } from './access.server';
import {
  type Budgets,
  type Held,
  minimumCharge,
  reserveFor,
  statementFailure,
} from './allowance.server';

/** What the steps read, swapped out in tests. */
export type AdmissionDeps = {
  /** Who the request asks as (lib/ask/access.server). */
  standing: () => Promise<AskStanding>;
  /** Whether a token is a live one issued for the key (lib/device/token.server). */
  tokenMatches: (token: string, key: string) => boolean;
  /** Whether the key is on a list of refused devices (lib/device/suspended.server). */
  listed: (key: string) => Promise<boolean>;
  /** The tokens a device's, a network's and the site's asks may each use before a cooldown; null where none is set (lib/ask/allowance.server). */
  budgets: () => Budgets;
  /** The key the request's network is counted under; null when it is not known (lib/ask/subjects.server). */
  network: () => string | null;
  /** The key the site's total is kept under (lib/ask/subjects.server). */
  site: () => string;
  /** When a total that is waiting out a cooldown opens again; null when it is not waiting. */
  cooling: (key: string) => Promise<number | null>;
  /** Admits one ask on a hold of `reserve` tokens against one total's budget, says when that total opens again, or says it is busy. */
  hold: (key: string, budget: number, reserve: number) => Promise<Held>;
  /** Gives up an admitted ask's hold of `reserve` tokens on one total for the tokens it is charged, in the window the hold was set in (`opened`). */
  settle: (
    key: string,
    opened: string,
    charge: number,
    budget: number,
    reserve: number,
  ) => Promise<void>;
  /** The browser check's verdict on the request (lib/device/browser-check.server). */
  verdict: () => Promise<BrowserVerdict | 'unchecked'>;
};

/** What a mint is answered with: a token to issue, nothing for a request that may not ask at all (`nobody`) or one refused, or the time asking opens again for it. */
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

/** What a plan or a further slice is answered with before any judging: admitted, with the charge to settle afterwards; refused; told when asking opens again for it; or told nothing could decide it right now. */
export type Admission =
  | { status: 'admitted'; charge: Charge }
  | { status: 'denied' }
  | { status: 'cooldown'; until: number }
  | { status: 'unavailable' };

const DENIED: Admission = { status: 'denied' };
const UNAVAILABLE: Admission = { status: 'unavailable' };

/** The charge of an ask no total is kept for: the owner's, or a local run's with no budget set. */
const UNCHARGED: Charge = async () => {};

/** One total an ask is counted against: the key of its row, and the tokens it may reach in a window. */
type Counted = { key: string; budget: number };

/** A hold an ask has on one total: what it set aside, and the window it was set in. */
type Hold = Counted & { opened: string; reserve: number };

/**
 * The totals a visitor's ask is counted against, in the order they are held:
 * its device's, its network's, the site's. A public visitor needs all three
 * (`missing` without a budget or a network to count it under, and said so,
 * so asking never opens to all unmetered); a local run is counted against
 * those that are set, and may go without any.
 */
function countedFor(
  standing: 'local' | 'public',
  key: string,
  deps: AdmissionDeps,
): Counted[] | 'missing' {
  const budgets = deps.budgets();
  const network = deps.network();
  const totals: [string, string | null, number | null][] = [
    ['ASK_DAILY_TOKENS', key, budgets.device],
    ['ASK_DAILY_TOKENS_NETWORK', network, budgets.network],
    ['ASK_DAILY_TOKENS_SITE', deps.site(), budgets.site],
  ];
  if (standing === 'public') {
    const unset = totals.flatMap(([name, , budget]) =>
      budget === null ? [name] : [],
    );
    if (unset.length > 0) {
      console.error(`[ask] ${unset.join(', ')} not set`);
      return 'missing';
    }
    if (network === null) {
      console.error(
        '[ask] no network to count the request under: no address, or ENGAGE_TOKEN_SECRET not set',
      );
      return 'missing';
    }
  }
  return totals.flatMap(([, id, budget]) =>
    id !== null && budget !== null ? [{ key: id, budget }] : [],
  );
}

/** Settles every hold at one charge, each on its own: one that cannot be written is said and left, and the rest are still settled. Never throws. */
async function settleAll(
  holds: readonly Hold[],
  charge: number,
  deps: AdmissionDeps,
): Promise<void> {
  await Promise.all(
    holds.map(async ({ key, opened, budget, reserve }) => {
      try {
        await deps.settle(key, opened, charge, budget, reserve);
      } catch (error) {
        console.error(
          '[ask] usage could not be settled:',
          statementFailure(error),
        );
      }
    }),
  );
}

/** Settles an ask's holds at a charge, the first time it is called. */
function settling(
  holds: readonly Hold[],
  deps: AdmissionDeps,
): (charge: number) => Promise<void> {
  let settled = false;
  return async (charge) => {
    if (settled) return;
    settled = true;
    await settleAll(holds, charge, deps);
  };
}

/**
 * Whether a device key is issued a token. A request that may not ask is
 * `nobody` before anything else is read. A listed key is refused, the
 * owner's too. A visitor whose device, network or site total is waiting out
 * a cooldown is told when it ends, before the browser check is asked; a wait
 * that cannot be read is left for the ask's own hold to decide. A client the
 * check names automated is refused whatever `BROWSER_CHECK_ENFORCE` says; a
 * check that could not run still issues, as each ask is checked again. A mint
 * is charged nothing.
 */
export async function admitMint(
  key: string,
  deps: AdmissionDeps,
): Promise<MintAdmission> {
  const standing = await deps.standing();
  if (standing === null) return { status: 'nobody' };
  if (await deps.listed(key)) return { status: 'refused' };
  if (standing === 'owner') return { status: 'issue' };
  const counted = countedFor(standing, key, deps);
  if (counted === 'missing') return { status: 'refused' };
  for (const total of counted) {
    let until: number | null = null;
    try {
      until = await deps.cooling(total.key);
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
 * A visitor's ask is admitted on a hold against each total it is counted
 * against, its device's first, then its network's, then the site's, all taken
 * before the billed check. A total waiting out a cooldown ends it there: the
 * holds already taken are given back and the visitor is told when it ends.
 * A total whose room is taken up by asks still running ends it too, as
 * `unavailable`: no cooldown is told, as there is room again once they
 * settle. An ask whose hold cannot be written is `unavailable` as well, so
 * none is answered unmetered. Last, only a browser the check names a person's is admitted,
 * whatever `BROWSER_CHECK_ENFORCE` says. A client it names automated is
 * `denied` and charged the least an ask costs; a check that could not run is
 * `unavailable` and charged nothing.
 *
 * The caller of an admitted ask owes it one `charge`, with the tokens the
 * ask used, however the ask ended; every total is charged the same.
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
  const counted = countedFor(standing, key, deps);
  if (counted === 'missing') return DENIED;
  if (counted.length === 0) {
    const verdict = await deps.verdict();
    if (verdict === 'person') return { status: 'admitted', charge: UNCHARGED };
    return verdict === 'unchecked' ? UNAVAILABLE : DENIED;
  }
  // The least an ask costs is measured on the first total it is counted against: the device's, where one is kept.
  const least = minimumCharge(counted[0].budget);
  // What it sets aside on every total while it runs: never less than it will be charged.
  const reserve = reserveFor(least);
  const holds: Hold[] = [];
  for (const total of counted) {
    let held: Held;
    try {
      held = await deps.hold(total.key, total.budget, reserve);
    } catch (error) {
      console.error(
        '[ask] usage could not be counted:',
        statementFailure(error),
      );
      await settleAll(holds, 0, deps);
      return UNAVAILABLE;
    }
    if (!held.admitted) {
      await settleAll(holds, 0, deps);
      // Room taken up by asks still running is no cooldown: there is room again as they settle.
      return 'until' in held
        ? { status: 'cooldown', until: held.until }
        : UNAVAILABLE;
    }
    holds.push({ ...total, opened: held.opened, reserve });
  }
  const settle = settling(holds, deps);
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
