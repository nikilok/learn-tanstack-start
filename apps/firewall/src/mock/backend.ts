// What a mock session answers with: traffic reads served from the cassette, and a WAF that lives
// in memory for as long as the session does.

import { asChoice, effectiveAction, withAction } from '../actions';
import type { WafBackend } from '../client';
import { isDryRun } from '../env';
import type { MetricsResponse, ObservabilityBackend } from '../observability';
import { headerKeysByGroup } from '../rule-integrity';
import type { LiveConfig } from '../seed-items';
import {
  type LoadedCassette,
  LIVE_CONFIG_KEY,
  RULE_NAMES_KEY,
  metricsKeys,
} from './cassette';
import { decodeRuleNames } from './codec';

/** How a replayed query was answered. A pane full of zeroes is either a quiet window or a gap in the corpus, and only this can tell them apart. */
export type Miss = { key: string; reason: 'unrecorded' | 'window-substituted' };

const EMPTY: MetricsResponse = { data: [], summary: [] };

/** Observability reads answered from a recording. An unrecorded query returns a well-formed empty response — the same thing a genuinely quiet window returns, so every reader already handles it — and is reported rather than thrown. */
export function mockObservability(
  cassette: LoadedCassette,
  onMiss: (miss: Miss) => void,
): ObservabilityBackend {
  return {
    async metrics(ctx, groupBy, opts) {
      const { exact, loose } = metricsKeys(ctx, groupBy, opts);
      if (cassette.entries.has(exact))
        return cassette.entries.get(exact) as MetricsResponse;
      // Recorded for a different range. Returned deliberately: the operator moves the window
      // constantly and a corpus that only answers the range it was recorded at is barely a corpus.
      if (cassette.loose.has(loose)) {
        onMiss({ key: exact, reason: 'window-substituted' });
        return cassette.loose.get(loose) as MetricsResponse;
      }
      onMiss({ key: exact, reason: 'unrecorded' });
      return EMPTY;
    },
    async ruleNames() {
      const raw = cassette.entries.get(RULE_NAMES_KEY);
      if (raw === undefined)
        onMiss({ key: RULE_NAMES_KEY, reason: 'unrecorded' });
      return decodeRuleNames(raw);
    },
  };
}

/** A fresh copy, so a caller mutating what it read cannot rewrite the session's WAF behind its back. */
function cloneLive(config: LiveConfig): LiveConfig {
  return {
    idByName: new Map(config.idByName),
    activeByName: new Map(config.activeByName),
    actionByName: new Map(config.actionByName),
    headerKeysByName: new Map(
      [...config.headerKeysByName].map(([name, groups]) => [
        name,
        groups.map((g) => new Set(g)),
      ]),
    ),
  };
}

/**
 * A WAF that remembers.
 *
 * An apply has to CHANGE what the next fetch returns, or the flow this mode exists to exercise —
 * stage a challenge, promote it to a deny, lift it — reads as a no-op every time and the pane
 * never shows the state the promotion produced.
 */
export function mockWaf(
  initial: LiveConfig,
  /** Injected rather than read from the environment: the suite runs under DRY_RUN=1, so a global read would make every apply test a no-op. */
  opts: { dryRun?: boolean } = {},
): WafBackend {
  const dryRun = opts.dryRun ?? isDryRun();
  const config = cloneLive(initial);
  return {
    async fetchLive() {
      return cloneLive(config);
    },
    async applyItem(item) {
      const rule = withAction(
        { ...item.rule, active: item.active },
        item.action,
      );
      const known = config.idByName.has(rule.name);
      const status = known ? 'overwrote' : 'inserted';
      // The same early return the live path takes, so a dry run inside a mock session does not
      // leave the WAF changed and the persisted lists not.
      if (dryRun) return { status, detail: 'dry-run' };
      if (!known)
        config.idByName.set(rule.name, `mock_rule_${config.idByName.size + 1}`);
      config.activeByName.set(rule.name, rule.active);
      // Read back off the BUILT rule, the way liveFetchLive reads it off the live one — never from
      // item.action. `withAction` refuses to turn the challenge rule into a deny, so the two
      // disagree for exactly the tier this mode exists to exercise.
      const choice = asChoice(effectiveAction(rule.action.mitigate));
      if (choice) config.actionByName.set(rule.name, choice);
      config.headerKeysByName.set(rule.name, headerKeysByGroup(rule));
      return { status };
    },
  };
}

/** The live config a session starts from, or an empty one when nothing was ever recorded. */
export function recordedLiveConfig(cassette: LoadedCassette): unknown {
  return cassette.entries.get(LIVE_CONFIG_KEY);
}
