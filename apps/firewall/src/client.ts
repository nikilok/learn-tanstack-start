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
import { unboundedPreviewBypass } from './preview-bypass';
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
  for (const r of config.rules ?? []) {
    idByName.set(r.name, r.id);
    activeByName.set(r.name, r.active);
    const m = r.action.mitigate;
    const c = m ? asChoice(effectiveAction(m)) : undefined;
    if (c) actionByName.set(r.name, c);
  }
  return { idByName, activeByName, actionByName };
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

/** Non-interactive apply (CI / piped, no TTY): ensure every rule exists, preserving each rule's LIVE active + action (never reverting enforcement). Sets a non-zero exit code if any rule fails. */
export async function runHeadless() {
  const live = await fetchLive();
  let anyError = false;
  const items = seedItems(live);
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
  // `items` is seeded state plus code defaults, not what actually landed. A ceiling that FAILED
  // to apply is not in force, so it is reported as inactive here — otherwise the one warning an
  // operator reads for this risk stays silent in exactly the case that creates it.
  const unbounded = unboundedPreviewBypass(
    items.map((i) => ({
      name: i.rule.name,
      active: i.active && !failedRules.has(i.rule.name),
      action: i.action,
    })),
  );
  if (unbounded) console.log(`\nWARNING: ${unbounded}`);
  if (anyError) process.exitCode = 1;
  console.log(
    '\nApplied. Live enforcement preserved; new rules inserted with code defaults. Tune actions in the TUI.',
  );
}
