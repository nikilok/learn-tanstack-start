// Recording wrappers: pass every read through to the real thing and append what came back.
//
// A recording session is a LIVE session with a side effect. It must never change what the tool
// does, so a failed append is swallowed — losing a line of corpus is not worth losing the run.

import type { WafBackend } from '../client';
import type { ObservabilityBackend } from '../observability';
import {
  LIVE_CONFIG_KEY,
  RULE_NAMES_KEY,
  appendCassette,
  metricsKeys,
} from './cassette';
import { encodeLiveConfig, encodeRuleNames } from './codec';

function capture(
  path: string,
  key: string,
  value: unknown,
  loose?: string,
): void {
  try {
    appendCassette(path, key, value, loose);
  } catch {
    // A cassette that cannot be written is not a reason to fail an operator's live session.
  }
}

/** Wrap the live traffic reads so every response lands in the cassette. */
export function recordingObservability(
  live: ObservabilityBackend,
  path: string,
): ObservabilityBackend {
  return {
    async metrics(ctx, groupBy, opts) {
      const response = await live.metrics(ctx, groupBy, opts);
      const { exact, loose } = metricsKeys(ctx, groupBy, opts);
      capture(path, exact, response, loose);
      return response;
    },
    async ruleNames(ctx) {
      const names = await live.ruleNames(ctx);
      capture(path, RULE_NAMES_KEY, encodeRuleNames(names));
      return names;
    },
  };
}

/** Wrap the live WAF read. Writes pass straight through untouched — a recording session applies for real. */
export function recordingWaf(live: WafBackend, path: string): WafBackend {
  return {
    async fetchLive() {
      const config = await live.fetchLive();
      capture(path, LIVE_CONFIG_KEY, encodeLiveConfig(config));
      return config;
    },
    applyItem: live.applyItem,
  };
}
