// Vercel data layer for the rule manager: the SDK client, the row-state types, and the
// fetch/seed/apply operations shared by the TUI and the headless path.

import { Vercel } from '@vercel/sdk';

import { asChoice, effectiveAction, withAction } from './actions';
import { resolveVercelCredentials } from './credentials';
import { isMock, isRecording } from './env';
import { headerKeysByGroup } from './rule-integrity';
import { type ActionChoice, type Rule, dryRun } from './rules';
import { appliedNote } from './run-mode';
import {
  type ApplyStatus,
  type Item,
  type LiveConfig,
  seedItems,
} from './seed-items';

export type { ApplyStatus, Item, LiveConfig };
import { errMsg } from './util';

export const { projectId, teamId, token } = resolveVercelCredentials();
const vercel = new Vercel({ bearerToken: token });

/** Fetch the active firewall config and index our rules' current id + active state + governing action by name. */
async function liveFetchLive(): Promise<LiveConfig> {
  const config = await vercel.security.getFirewallConfig({
    projectId,
    teamId,
    configVersion: 'active',
  });
  const idByName = new Map<string, string>();
  const activeByName = new Map<string, boolean>();
  const actionByName = new Map<string, ActionChoice>();
  const headerKeysByName = new Map<string, Set<string>[]>();
  for (const r of config.rules ?? []) {
    idByName.set(r.name, r.id);
    activeByName.set(r.name, r.active);
    headerKeysByName.set(r.name, headerKeysByGroup(r));
    const m = r.action.mitigate;
    const c = m ? asChoice(effectiveAction(m)) : undefined;
    if (c) actionByName.set(r.name, c);
  }
  return { idByName, activeByName, actionByName, headerKeysByName };
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
async function liveApplyItem(
  item: Item,
  idByName: Map<string, string>,
): Promise<{ status: ApplyStatus; detail?: string }> {
  return applyRule(
    withAction({ ...item.rule, active: item.active }, item.action),
    idByName,
  );
}

/** Every read and write this tool makes against the live WAF, behind one replaceable object. */
export type WafBackend = {
  fetchLive: () => Promise<LiveConfig>;
  applyItem: (
    item: Item,
    idByName: Map<string, string>,
  ) => Promise<{ status: ApplyStatus; detail?: string }>;
};

/** The real thing, exported so a recording session can wrap it rather than reimplement it. */
export const liveWaf: WafBackend = {
  fetchLive: liveFetchLive,
  applyItem: liveApplyItem,
};

let backend: WafBackend = liveWaf;

/** Redirect the WAF read/write pair. Refuses outside a mock or recording session. */
export function installWafBackend(next: WafBackend): void {
  if (!isMock() && !isRecording())
    throw new Error(
      'the WAF backend is only replaceable under --mock or --record',
    );
  backend = next;
}

/** The active firewall config, indexed by rule name. */
export function fetchLive(): Promise<LiveConfig> {
  return backend.fetchLive();
}

/** Upsert one item's rule, honouring dry-run. */
export function applyItem(
  item: Item,
  idByName: Map<string, string>,
): Promise<{ status: ApplyStatus; detail?: string }> {
  return backend.applyItem(item, idByName);
}

/** Non-interactive apply (CI / piped, no TTY): ensure every rule exists, preserving each rule's LIVE active + action (never reverting enforcement). Sets a non-zero exit code if any rule fails. */
export async function runHeadless() {
  const live = await fetchLive();
  let anyError = false;
  const items = seedItems(live);
  for (const item of items) {
    try {
      const { status, detail } = await applyItem(item, live.idByName);
      if (status === 'error') anyError = true; // a returned (not thrown) error must still fail the run
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
      console.log(`error (${errMsg(e)})  ${item.rule.name}`);
    }
  }
  if (anyError) process.exitCode = 1;
  // "Live enforcement preserved" is a claim about production, and it is false in a mock session and
  // in a recording — the same thing the (LIVE) badge said before it learned about mock mode.
  console.log(`\n${appliedNote({ mock: isMock(), recording: isRecording() })}`);
}
