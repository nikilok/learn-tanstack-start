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
import { JA4_DENY, valuesOf, withValue, withoutValue } from './deny-list';
import { PERSIST_TARGETS } from './deny-persist';
import { JA4_RULE } from './deny-staging';
import { persistEnvVar, readFwVars } from './env-file';
import { envPath } from './hooks/useDenylist';
import type { Finding } from './watch';
import { logWatch } from './watch-log';
import { notify } from './watch-notify';

export type WafEdit =
  | { ok: true; status: string; values: string[] }
  /**
   * `mutated` — whether the apply was REACHED, so the live rule may already carry the change.
   * A failure after that point is not "nothing happened": the deny can be live and enforced, and
   * treating it as a no-op is how a temporary ban loses its clock and becomes permanent.
   */
  | { ok: false; error: string; mutated: boolean };

/** Whichever env var the operator's own apply rebuilds the JA4 deny rule from. */
const JA4_ENV = PERSIST_TARGETS.find((t) => t.rule === JA4_RULE)?.envKey ?? '';

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
  // Flipped the instant the apply is reached, so a throw can be told apart from a no-op.
  let attempted = false;
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
      return {
        ok: false,
        error: `${JA4_RULE} is not in the built rule set`,
        mutated: false,
      };
    // Checked here for BOTH directions. `withValue` validates; `withoutValue` only filters, so a
    // malformed value removes nothing and still returns a rule — reported as a successful lift
    // while the deny stays live, which is a ban with no expiry record behind it.
    if (!JA4_DENY.valid(JA4_DENY.normalize(digest.trim())))
      return {
        ok: false,
        error: `not a JA4 digest: ${digest}`,
        mutated: false,
      };
    const edited =
      direction === 'add'
        ? withValue(item.rule, JA4_DENY, digest)
        : withoutValue(item.rule, JA4_DENY, digest);
    attempted = true;
    const { status, detail } = await applyItem(
      { ...item, rule: edited.rule },
      live.idByName,
    );
    if (status === 'error')
      // `mutated` even on a reported error: whether the write landed is not knowable from here,
      // and the two wrong answers are not equal. Claiming a mutation that did not happen costs a
      // no-op sweep; missing one that did costs a permanent ban.
      return {
        ok: false,
        error: detail ?? 'apply returned an error',
        mutated: true,
      };
    // A rule can be present and switched off in the dashboard. "overwrote" alone would read as
    // enforcement, so the deactivated case is reported as a failure to enforce, not a success.
    if (live.activeByName.get(JA4_RULE) === false)
      return {
        ok: false,
        error: `${JA4_RULE} is DEACTIVATED live — the digest was written but the WAF will not evaluate it`,
        // Written, and enforced the moment someone activates the rule in the dashboard.
        mutated: true,
      };
    // The OTHER half of an apply, and the half that makes it survive. `persistDenies` states the
    // rule this obeys: a deny live in the WAF but absent from .env.local is lifted by the next
    // apply, because that apply rebuilds this rule from env and writes it back. Applying without
    // it buys enforcement that lasts until the next time anyone presses `a`.
    // Written HERE rather than in the callers so both directions move together.
    const values = valuesOf(edited.rule, JA4_DENY);
    try {
      persistEnvVar(envPath(), JA4_ENV, values.join(','));
    } catch (e) {
      return {
        ok: false,
        error: `${JA4_ENV} not saved (${e instanceof Error ? e.message : String(e)}) — the WAF was changed and the next apply will undo it`,
        // The apply SUCCEEDED here; only the file write failed. The deny is live right now.
        mutated: true,
      };
    }
    return {
      ok: true,
      status: `${status}: ${edited.values.length} digest(s)`,
      values,
    };
  } catch (e) {
    // A throw before the apply cannot have changed anything; one after it might have.
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      mutated: attempted,
    };
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
  const { lift } = revocationPlan(
    parseExpiries(readFwVars(path)[AUTO_BAN_UNTIL]),
    Date.now(),
  );
  if (!lift.length) return;
  const lifted: Expiry[] = [];
  for (const rec of lift) {
    const edit = await editLiveJa4Deny(rec.digest, 'remove');
    if (edit.ok) {
      lifted.push(rec);
      void logWatch(root, new Date(), {
        kind: 'error',
        error: `auto-ban EXPIRED and lifted: ${rec.digest} (${edit.status})`,
      });
    } else {
      // Kept, not dropped. Forgetting a record we failed to lift is how an auto-ban silently
      // becomes permanent — the one outcome this whole mechanism exists to prevent.
      void logWatch(root, new Date(), {
        kind: 'error',
        error: `auto-ban expiry FAILED for ${rec.digest}: ${edit.error} — still denied, will retry`,
      });
    }
  }
  // RE-READ. The edits above are network calls, and both entrypoints can apply a ban — a record
  // added in that window is absent from `keep`, and writing the stale snapshot would drop its
  // expiry while its deny stays live. That is a permanent auto-ban, the one outcome this module
  // exists to prevent. Only what we actually lifted is removed; everything else survives.
  // Matched on the digest AND its expiry. A re-ban during the awaits above writes a NEW record for
  // the same fingerprint, and retiring by digest alone would delete that one too — leaving its deny
  // live with no clock.
  const key = (r: Expiry) => `${r.digest}@${r.until}`;
  const retired = new Set(lifted.map(key));
  persistEnvVar(
    path,
    AUTO_BAN_UNTIL,
    serialiseExpiries(
      parseExpiries(readFwVars(path)[AUTO_BAN_UNTIL]).filter(
        (r) => !retired.has(key(r)),
      ),
    ),
  );
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
  const digest = JA4_DENY.normalize(f.digest.trim());
  // Already denied, so there is nothing to add — and more to the point, an expiry written now
  // would later lift a ban this path never placed. Auto-bans only ever expire their OWN work.
  const listed = (readFwVars(path)[JA4_ENV] ?? '')
    .split(',')
    .map((v) => JA4_DENY.normalize(v.trim()));
  if (listed.includes(digest)) {
    void logWatch(root, new Date(), {
      kind: 'shadow',
      digest: f.digest,
      refusal: `already denied — leaving the existing ban alone`,
    });
    return;
  }
  // The expiry record goes down FIRST, before anything is enforced. Written after the apply, a
  // failed write would leave a deny that survives a rebuild with no clock on it — permanent, and
  // placed by nobody. This order can only ever leave a clock with no ban, which the next sweep
  // clears harmlessly.
  const prior = parseExpiries(readFwVars(path)[AUTO_BAN_UNTIL]);
  persistEnvVar(
    path,
    AUTO_BAN_UNTIL,
    serialiseExpiries([...prior, { digest, until: decision.until }]),
  );
  const edit = await editLiveJa4Deny(f.digest, 'add');
  if (!edit.ok) {
    if (edit.mutated) {
      // The clock STAYS. The apply was reached, so the deny may be live and enforced this second —
      // and a live deny whose expiry we just deleted is a permanent ban placed by nobody. Keeping
      // it costs at worst a sweep that lifts a digest which was never there, which is a no-op.
      void logWatch(root, new Date(), {
        kind: 'error',
        error: `AUTO-BAN PARTIAL for ${f.digest}: ${edit.error} — the deny MAY be live; its expiry is kept so it still lifts`,
      });
      return;
    }
    // Nothing reached the WAF, so the clock is removed with it — by exact instance, since another
    // process may have written a newer expiry for this same digest meanwhile.
    persistEnvVar(
      path,
      AUTO_BAN_UNTIL,
      serialiseExpiries(
        parseExpiries(readFwVars(path)[AUTO_BAN_UNTIL]).filter(
          (r) => !(r.digest === digest && r.until === decision.until),
        ),
      ),
    );
    void logWatch(root, new Date(), {
      kind: 'error',
      error: `AUTO-BAN FAILED for ${f.digest}: ${edit.error} — nothing is enforced`,
    });
    return;
  }
  const until = new Date(decision.until);
  persistEnvVar(path, AUTO_BAN_STRIKES, serialiseStrikes(decision.strikes));
  // Written for a lock screen: what happened, when it undoes itself, and how to undo it sooner.
  const note = [
    `AUTO-BAN applied: ${f.digest}`,
    `for ${ttlLabel(decision.ttlMs)} — lifts itself at ${until.toISOString()}`,
    `undo now: press u on the bans pane, or drop it from ${JA4_ENV} and apply`,
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
