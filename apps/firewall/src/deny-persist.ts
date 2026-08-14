// Writing applied denies back to .env.local, which is what the rules are rebuilt from every apply.

import { ASN_DENY, JA4_DENY, valuesOf } from './deny-list';
import { ASN_RULE, JA4_RULE } from './deny-staging';
import { CHALLENGE_SCRAPER_JA4 } from './rule-names';
import type { ApplyStatus, Item } from './seed-items';
import { errMsg } from './util';

/**
 * Each list rule and the env var it is rebuilt from.
 *
 * The challenge tier persists on the same pass, because `stage` PROMOTES off it. Write the deny
 * without the removal and the next apply rebuilds FW_CHALLENGE_JA4 from a stale env and puts the
 * digest straight back on both lists — the exact half-applied state the promotion exists to
 * prevent. Idempotent when nothing was promoted: it writes the rule's own current values back.
 */
export const PERSIST_TARGETS = [
  { rule: JA4_RULE, spec: JA4_DENY, envKey: 'FW_BLOCKED_JA4' },
  { rule: ASN_RULE, spec: ASN_DENY, envKey: 'FW_BLOCKED_ASN' },
  { rule: CHALLENGE_SCRAPER_JA4, spec: JA4_DENY, envKey: 'FW_CHALLENGE_JA4' },
] as const;

export type PersistResult = {
  /** Load-bearing: a deny live in the WAF but absent from .env.local is lifted by the next apply, so it must fail the run rather than only warn. */
  ok: boolean;
  summary: string;
  /** Whether the staged and removed lists are now fully written and can be cleared. */
  clearStaged: boolean;
};

/**
 * Write each deny rule that actually reached the WAF back to env.
 *
 * `write` is injected so the decision — which rules to write, and what to report when one fails —
 * is testable without touching a file.
 */
export function persistDenies(opts: {
  snapshot: Item[];
  outcome: Map<string, ApplyStatus>;
  /** Whether anything is staged or lifted at all. */
  pending: boolean;
  dryRun: boolean;
  write: (envKey: string, value: string) => void;
}): PersistResult {
  const { snapshot, outcome, pending, dryRun, write } = opts;
  if (!pending) return { ok: true, summary: '', clearStaged: false };
  // A dry run reaches no WAF, so writing the denylist back would enforce or lift a ban the
  // operator only previewed — .env.local is what the next real apply and CI rebuild from.
  if (dryRun)
    return {
      ok: true,
      summary: ' · dry-run: .env.local NOT written',
      clearStaged: false,
    };
  const notes: string[] = [];
  let wrote = false;
  // A cancelled run breaks out of the apply part-way, so `outcome` can hold one deny rule and not
  // the other. Clearing the staged lists on the strength of the one that landed would drop the
  // other's values unpersisted, and the next apply rebuilds from env and lifts them.
  let unreached = false;
  for (const { rule, spec, envKey } of PERSIST_TARGETS) {
    const item = snapshot.find((it) => it.rule.name === rule);
    const status = outcome.get(rule);
    if (!item) continue;
    if (!status) {
      unreached = true;
      continue;
    }
    if (status === 'error') {
      notes.push(`${envKey} NOT saved — ${rule} failed to apply`);
      continue;
    }
    try {
      write(envKey, valuesOf(item.rule, spec).join(','));
      wrote = true;
    } catch (e) {
      notes.push(
        `${envKey} NOT saved (${errMsg(e)}) — the next apply will undo it`,
      );
    }
  }
  if (wrote && !notes.length && !unreached)
    return {
      ok: true,
      summary: ' · denylist saved to .env.local',
      clearStaged: true,
    };
  if (unreached)
    notes.push(
      'a deny rule was never reached, so its staged edits are still unapplied',
    );
  // A vacuous pass otherwise: edits are pending, nothing matched, nothing was written, and the
  // run reports success having persisted none of it.
  if (!wrote && !notes.length)
    notes.push('no deny rule was in this config, so nothing was saved');
  return {
    ok: !notes.length,
    summary: notes.length ? ` · WARNING: ${notes.join('; ')}` : '',
    clearStaged: false,
  };
}
