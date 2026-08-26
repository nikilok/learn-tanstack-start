// Turning an autonomous ban decision into a WAF change, and undoing it when its clock runs out.
//
// The decision is pure and lives here; the effects are injected. That split is not tidiness — this
// is the only path in the tool that can deny live traffic with nobody watching, so what it decides
// has to be exercisable without a WAF, a file, or a network.
//
// Two independent gates are required, and every ban it applies expires on its own. The reasoning
// behind both, and the figures they were calibrated against, are in the ops-repo runbook.

import {
  type Expiry,
  type Strike,
  addStrike,
  autoBanEnabled,
  banDuration,
  dueForRevocation,
  strikesFor,
} from './auto-ban';

export type AutoBanDecision =
  | { apply: false; reason: string }
  | { apply: true; until: number; strikes: Strike[]; ttlMs: number };

/**
 * Whether to deny this identity without a human, and for how long.
 *
 * Returns the REASON for every refusal rather than a bare false: a gate that declines silently is
 * indistinguishable from one that never ran, and this one runs on the unattended path.
 */
export function autoBanDecision(opts: {
  digest: string;
  /** The investigation agent's parsed verdict. */
  agentVerdict: string;
  /** `autoBanRefusal`'s answer: null means the advisory cleared every ceiling. */
  refusal: string | null;
  env: Record<string, string | undefined>;
  strikes: Strike[];
  now: number;
}): AutoBanDecision {
  const { digest, agentVerdict, refusal, env, strikes, now } = opts;
  if (!autoBanEnabled(env))
    return { apply: false, reason: `${'FW_AUTO_BAN'} is not 1 — advise only` };
  // `unclear` is a deliberate output of that protocol, never a soft ban.
  if (agentVerdict !== 'ban')
    return { apply: false, reason: `agent said ${agentVerdict}, not ban` };
  // Both gates, never either.
  if (refusal) return { apply: false, reason: refusal };
  const prior = strikesFor(strikes, digest, now);
  const ttlMs = banDuration(prior);
  return {
    apply: true,
    ttlMs,
    until: now + ttlMs,
    strikes: addStrike(strikes, digest, now),
  };
}

/** A duration a half-awake operator reads correctly off a notification. */
export function ttlLabel(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
}

export type Revocation = {
  /** RECORDS, not bare digests: a lift has to name the exact expiry instance it is retiring, or a newer one written for the same fingerprint is deleted along with it. */
  lift: Expiry[];
  /** The records still running, to be written back. */
  keep: Expiry[];
};

/** Which auto-bans have served their time. Called every tick, before anything new is applied. */
export function revocationPlan(records: Expiry[], now: number): Revocation {
  const { expired, live } = dueForRevocation(records, now);
  return { lift: expired, keep: live };
}
