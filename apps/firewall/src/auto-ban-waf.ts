// The effects behind an autonomous ban: edit the live rule, then write .env.local to match.
//
// Deliberately the SAME path the operator's `b` + `a` takes — `withValue`/`withoutValue` over the
// seeded item, then `applyItem`. A bespoke writer here would drift from what the TUI does and the
// drift would only ever show up on the unattended path.
//
// `rules.ts` reads FW_BLOCKED_JA4 at MODULE LOAD, so mutating process.env and re-importing does
// nothing — the rule is already built. Editing the seeded item is what actually changes the WAF.

import {
  AUTO_BAN_STRIKES,
  AUTO_BAN_UNTIL,
  type Expiry,
  parseExpiries,
  parseStrikes,
  serialiseExpiries,
  serialiseStrikes,
} from './auto-ban';
import { autoBanDecision, revocationPlan, ttlLabel } from './auto-ban-apply';
import { JA4_DENY, withValue, withoutValue } from './deny-list';
import { JA4_RULE } from './deny-staging';
import { persistEnvVar, readFwVars } from './env-file';
import { envPath } from './hooks/useDenylist';
import type { Finding } from './watch';
import { logWatch } from './watch-log';
import { notify } from './watch-notify';

export type WafEdit =
  | { ok: true; status: string }
  | { ok: false; error: string };

/**
 * Add or remove one digest on the live deny rule.
 *
 * ORDER MATTERS, and it is the reverse for the two directions. Applying: the WAF first, then
 * .env.local — a file written for a rule that failed to apply reads as enforcement that is not
 * there, and the next apply would rebuild from it and claim the deny had been live all along.
 * Lifting: also the WAF first, because a ban we have decided is over must stop being enforced even
 * if the file write then fails; the mismatch is visible and the traffic is not blocked meanwhile.
 */
export async function editLiveJa4Deny(
  digest: string,
  direction: 'add' | 'remove',
): Promise<WafEdit> {
  try {
    // Imported HERE, not at module scope. `client.ts` resolves credentials and builds its SDK
    // client on evaluation, and since Bun 1.4 a failed evaluation is rethrown for ever — even
    // through mock.module. A static import would make every consumer of this file fail to load
    // once anything had tripped that, which is why `watch.ts` reaches for it the same way.
    // `seed-items` reaches `rules.ts`, which reads its ceilings from the environment AT IMPORT
    // TIME and throws when they are missing — the same evaluate-once hazard as `client`, and it
    // poisons every module that pulls it in statically. Both are loaded on the call instead.
    const [{ applyItem, fetchLive }, { seedItems }] = await Promise.all([
      import('./client'),
      import('./seed-items'),
    ]);
    const live = await fetchLive();
    const item = seedItems(live).find((i) => i.rule.name === JA4_RULE);
    if (!item)
      return { ok: false, error: `${JA4_RULE} is not in the built rule set` };
    // Refuses on a malformed digest rather than writing a rule that matches nothing — the failure
    // that would read as "banned" while serving every request.
    const edited =
      direction === 'add'
        ? withValue(item.rule, JA4_DENY, digest)
        : withoutValue(item.rule, JA4_DENY, digest);
    const { status, detail } = await applyItem(
      { ...item, rule: edited.rule },
      live.idByName,
    );
    if (status === 'error')
      return { ok: false, error: detail ?? 'apply returned an error' };
    // A rule can be present and switched off in the dashboard. "overwrote" alone would read as
    // enforcement, so the deactivated case is reported as a failure to enforce, not a success.
    if (live.activeByName.get(JA4_RULE) === false)
      return {
        ok: false,
        error: `${JA4_RULE} is DEACTIVATED live — the digest was written but the WAF will not evaluate it`,
      };
    return { ok: true, status: `${status}: ${edited.values.length} digest(s)` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Lift every auto-ban whose clock has run out.
 *
 * The WAF first, then the file. A ban we have decided is over must stop being enforced even if the
 * write then fails — the mismatch is visible on the next apply, and nobody is blocked meanwhile.
 * Failures are logged and the record KEPT, so the next tick tries again rather than leaving a deny
 * live with nothing tracking it.
 */
export async function liftExpiredAutoBans(root: string): Promise<void> {
  const path = envPath();
  const { lift, keep } = revocationPlan(
    parseExpiries(readFwVars(path)[AUTO_BAN_UNTIL]),
    Date.now(),
  );
  if (!lift.length) return;
  const stuck: Expiry[] = [];
  for (const digest of lift) {
    const edit = await editLiveJa4Deny(digest, 'remove');
    if (edit.ok) {
      void logWatch(root, new Date(), {
        kind: 'error',
        error: `auto-ban EXPIRED and lifted: ${digest} (${edit.status})`,
      });
    } else {
      // Kept, not dropped. Forgetting a record we failed to lift is how an auto-ban silently
      // becomes permanent — the one outcome this whole mechanism exists to prevent.
      stuck.push({ digest, until: Date.now() });
      void logWatch(root, new Date(), {
        kind: 'error',
        error: `auto-ban expiry FAILED for ${digest}: ${edit.error} — still denied, will retry`,
      });
    }
  }
  persistEnvVar(path, AUTO_BAN_UNTIL, serialiseExpiries([...keep, ...stuck]));
}

/**
 * Deny an identity without a human, when both gates agree, and only ever temporarily.
 *
 * The WAF first, then .env.local: a file written for a rule that failed to apply reads as
 * enforcement that is not there, and the next apply rebuilds from that file.
 */
export async function maybeAutoBan(
  root: string,
  f: Finding,
  agentVerdict: string,
): Promise<void> {
  const path = envPath();
  const vars = readFwVars(path);
  const decision = autoBanDecision({
    digest: f.digest,
    agentVerdict,
    refusal: f.autoBanRefusal,
    env: process.env,
    strikes: parseStrikes(vars[AUTO_BAN_STRIKES]),
    now: Date.now(),
  });
  if (!decision.apply) {
    // Logged even when the flag is off. The refusals ARE the record that says whether arming this
    // would have been safe, and a gate that declines invisibly cannot be audited later.
    void logWatch(root, new Date(), {
      kind: 'shadow',
      digest: f.digest,
      refusal: decision.reason,
    });
    return;
  }
  const edit = await editLiveJa4Deny(f.digest, 'add');
  if (!edit.ok) {
    void logWatch(root, new Date(), {
      kind: 'error',
      error: `AUTO-BAN FAILED for ${f.digest}: ${edit.error} — nothing was written`,
    });
    return;
  }
  const until = new Date(decision.until);
  persistEnvVar(
    path,
    AUTO_BAN_UNTIL,
    serialiseExpiries([
      ...parseExpiries(readFwVars(path)[AUTO_BAN_UNTIL]),
      { digest: f.digest.toLowerCase(), until: decision.until },
    ]),
  );
  persistEnvVar(path, AUTO_BAN_STRIKES, serialiseStrikes(decision.strikes));
  // Written for a lock screen: what happened, when it undoes itself, and how to undo it sooner.
  const note = [
    `AUTO-BAN applied: ${f.digest}`,
    `for ${ttlLabel(decision.ttlMs)} — lifts itself at ${until.toISOString()}`,
    `undo now: drop it from FW_BLOCKED_JA4 and run bun run firewall:setup --apply`,
  ].join('\n');
  void logWatch(root, new Date(), { kind: 'error', error: note });
  // AWAITED, and its failure logged. `notify` returns the reason rather than throwing, so a
  // discarded result means a ban was applied and nobody was told — which is the single worst
  // outcome available here, worse than not applying it at all.
  const failed = await notify(note);
  if (failed)
    void logWatch(root, new Date(), {
      kind: 'error',
      error: `AUTO-BAN NOTIFICATION FAILED for ${f.digest}: ${failed} — the ban IS applied and unannounced`,
    });
}
