// Vercel data layer for the rule manager: the SDK client, the row-state types, and the
// fetch/seed/apply operations shared by the TUI and the headless path.

import { Vercel } from '@vercel/sdk';

import {
  actionOptions,
  asChoice,
  effectiveAction,
  withAction,
} from './actions';
import { resolveVercelCredentials } from './credentials';
import {
  type PreviewRuleState,
  ruleMatchesNothing,
  unboundedPreviewBypass,
} from './preview-bypass';
import { type ActionChoice, type Rule, dryRun, rules } from './rules';
import { errMsg } from './util';

export type ApplyStatus =
  | 'idle'
  | 'applying'
  | 'inserted'
  | 'overwrote'
  | 'error';
export type LiveConfig = {
  idByName: Map<string, string>;
  activeByName: Map<string, boolean>;
  actionByName: Map<string, ActionChoice>;
  /** Live evaluation order by rule name. Absent means the rule is not live yet. */
  orderByName: Map<string, number>;
};
export type Item = {
  rule: Rule;
  active: boolean;
  action: ActionChoice;
  status: ApplyStatus;
  detail?: string;
};

export const { projectId, teamId, token } = resolveVercelCredentials();
const vercel = new Vercel({ bearerToken: token });

/** Fetch the active firewall config and index our rules' current id + active state + governing action by name. */
export async function fetchLive(): Promise<LiveConfig> {
  const config = await vercel.security.getFirewallConfig({
    projectId,
    teamId,
    configVersion: 'active',
  });
  const idByName = new Map<string, string>();
  const activeByName = new Map<string, boolean>();
  const actionByName = new Map<string, ActionChoice>();
  // Array position IS the live evaluation order, and a bypass short-circuits everything after
  // it — so the interlock cannot be judged without this.
  const orderByName = new Map<string, number>();
  for (const [i, r] of (config.rules ?? []).entries()) {
    orderByName.set(r.name, i);
    idByName.set(r.name, r.id);
    activeByName.set(r.name, r.active);
    const m = r.action.mitigate;
    const c = m ? asChoice(effectiveAction(m)) : undefined;
    if (c) actionByName.set(r.name, c);
  }
  return { idByName, activeByName, actionByName, orderByName };
}

/** Seed each code rule's desired active + action, preferring the LIVE config so a run never silently downgrades operator-tuned enforcement; the action is clamped to the rule's valid options (so drift like a bypass on a rate-limit rule can't be re-applied as an invalid value). New rules fall back to code defaults. */
export function seedItems(live: LiveConfig): Item[] {
  return rules.map((rule) => {
    const opts = actionOptions(rule);
    const liveAction = live.actionByName.get(rule.name);
    const codeAction = asChoice(effectiveAction(rule.action.mitigate)) ?? 'log';
    const action =
      liveAction && opts.includes(liveAction)
        ? liveAction
        : opts.includes(codeAction)
          ? codeAction
          : opts[0];
    return {
      rule,
      active: live.activeByName.get(rule.name) ?? rule.active,
      action,
      status: 'idle',
    };
  });
}

/** Upsert one rule (insert if new, overwrite if it already exists), honouring dry-run. Returns the outcome for display. */
async function applyRule(
  rule: Rule,
  idByName: Map<string, string>,
): Promise<{ status: ApplyStatus; detail?: string }> {
  const id = idByName.get(rule.name);
  if (dryRun)
    return { status: id ? 'overwrote' : 'inserted', detail: 'dry-run' };
  if (id) {
    await vercel.security.updateFirewallConfig({
      projectId,
      teamId,
      requestBody: { action: 'rules.update', id, value: rule },
    });
    return { status: 'overwrote' };
  }
  await vercel.security.updateFirewallConfig({
    projectId,
    teamId,
    requestBody: { action: 'rules.insert', value: rule },
  });
  return { status: 'inserted' };
}

/** Build the live rule for an item (active + chosen action applied) and upsert it. Shared by the TUI (applyAll) and headless paths so they apply rules identically. */
export async function applyItem(
  item: Item,
  idByName: Map<string, string>,
): Promise<{ status: ApplyStatus; detail?: string }> {
  return applyRule(
    withAction({ ...item.rule, active: item.active }, item.action),
    idByName,
  );
}

/** Interlock state for one item: what the detector needs beyond name/active/action. `failed` marks a write whose outcome is unknown. */
export function previewStateOf(
  item: Item,
  orderByName: Map<string, number>,
  failed = false,
): PreviewRuleState {
  return {
    name: item.rule.name,
    active: item.active,
    action: item.action,
    matches: !ruleMatchesNothing(item.rule),
    order: orderByName.get(item.rule.name),
    unknown: failed,
  };
}

/** Non-interactive apply (CI / piped, no TTY): ensure every rule exists, preserving each rule's LIVE active + action (never reverting enforcement). Sets a non-zero exit code if any rule fails. */
export async function runHeadless() {
  const live = await fetchLive();
  let anyError = false;
  const items = seedItems(live);
  // Preflight, BEFORE anything is written. This path is the unattended one: applying first and
  // warning afterwards published an unbounded bypass into a CI log nobody reads, while the TUI
  // refused the identical input.
  const preflight = unboundedPreviewBypass(
    items.map((i) => previewStateOf(i, live.orderByName)),
  );
  if (preflight) {
    console.error(`REFUSED: nothing applied — ${preflight}`);
    process.exitCode = 1;
    return;
  }
  // Rules that did not land. The interlock warning below must judge what is IN FORCE, not what
  // was seeded.
  const failedRules = new Set<string>();
  for (const item of items) {
    try {
      const { status, detail } = await applyItem(item, live.idByName);
      if (status === 'error') {
        anyError = true; // a returned (not thrown) error must still fail the run
        failedRules.add(item.rule.name);
      }
      console.log(
        `${status}${detail ? ` (${detail})` : ''}  ${item.rule.name}`,
      );
      // "overwrote" alone reads as "in force", which is false in these two cases.
      if (live.activeByName.get(item.rule.name) === false)
        console.log(
          `  WARNING: ${item.rule.name} is DEACTIVATED live — this update was written but the WAF will not evaluate it`,
        );
      const liveAction = live.actionByName.get(item.rule.name);
      if (liveAction && liveAction !== item.action)
        console.log(
          `  WARNING: ${item.rule.name} live action "${liveAction}" is not valid for this rule — reset to "${item.action}"`,
        );
    } catch (e) {
      anyError = true;
      failedRules.add(item.rule.name);
      console.log(`error (${errMsg(e)})  ${item.rule.name}`);
    }
  }
  // A failed write is UNKNOWN, not off: applyRule is an upsert, so a failed update leaves the
  // previous rule live. The detector judges that worst-case per role rather than assuming the
  // rule vanished, which used to suppress the warning in exactly the state that creates it.
  const unbounded = unboundedPreviewBypass(
    items.map((i) =>
      previewStateOf(i, live.orderByName, failedRules.has(i.rule.name)),
    ),
  );
  if (unbounded) console.log(`\nWARNING: ${unbounded}`);
  if (anyError) process.exitCode = 1;
  console.log(
    '\nApplied. Live enforcement preserved; new rules inserted with code defaults. Tune actions in the TUI.',
  );
}
