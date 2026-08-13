// Turning the live firewall config into the editor's rows. Pure, and deliberately outside
// client.ts: that module resolves credentials at import time, so anything importing it needs them.

import { actionOptions, asChoice, effectiveAction } from './actions';
import { type ActionChoice, type Rule, rules } from './rules';

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
  /** Header keys each live rule requires, PER condition group — groups are OR'd, so the weakest one governs. */
  headerKeysByName: Map<string, Set<string>[]>;
};

export type Item = {
  rule: Rule;
  active: boolean;
  action: ActionChoice;
  status: ApplyStatus;
  detail?: string;
};

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

/** An empty live config — every rule falls back to the defaults it declares in code. */
export function noLiveConfig(): LiveConfig {
  return {
    idByName: new Map(),
    activeByName: new Map(),
    actionByName: new Map(),
    headerKeysByName: new Map(),
  };
}
