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

/**
 * What the recording actually managed to write.
 *
 * Counted rather than merely swallowed. A session where every append failed — an unwritable path,
 * a full disk — used to report "recording appended to <path>" and produce nothing, which is the
 * same silent-nothing the version guard exists to prevent at the other end.
 */
export type RecordingStats = { written: number; failed: number };

function capture(
  stats: RecordingStats,
  path: string,
  key: string,
  value: unknown,
  loose?: string,
): void {
  try {
    appendCassette(path, key, value, loose);
    stats.written++;
  } catch {
    // Still not a reason to fail an operator's live session — but the summary says how many.
    stats.failed++;
  }
}

/** Wrap the live traffic reads so every response lands in the cassette. */
export function recordingObservability(
  live: ObservabilityBackend,
  path: string,
  stats: RecordingStats,
): ObservabilityBackend {
  return {
    async metrics(ctx, groupBy, opts) {
      const response = await live.metrics(ctx, groupBy, opts);
      const { exact, loose } = metricsKeys(ctx, groupBy, opts);
      capture(stats, path, exact, response, loose);
      return response;
    },
    async ruleNames(ctx) {
      const names = await live.ruleNames(ctx);
      capture(stats, path, RULE_NAMES_KEY, encodeRuleNames(names));
      return names;
    },
  };
}

/** Wrap the live WAF read. Writes pass straight through untouched — a recording session applies for real. */
export function recordingWaf(
  live: WafBackend,
  path: string,
  stats: RecordingStats,
): WafBackend {
  return {
    async fetchLive() {
      const config = await live.fetchLive();
      capture(stats, path, LIVE_CONFIG_KEY, encodeLiveConfig(config));
      return config;
    },
    applyItem: live.applyItem,
  };
}
