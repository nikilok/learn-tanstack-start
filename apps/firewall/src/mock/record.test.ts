import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WafBackend } from '../client';
import type { Ctx, ObservabilityBackend } from '../observability';
import type { Item, LiveConfig } from '../seed-items';
import {
  LIVE_CONFIG_KEY,
  RULE_NAMES_KEY,
  loadCassette,
  metricsKeys,
} from './cassette';
import { recordingObservability, recordingWaf } from './record';

const CTX: Ctx = {
  projectId: 'prj',
  teamId: 'team',
  headers: {},
  qs: '',
  startTime: '2026-08-15T04:00:00.000Z',
  endTime: '2026-08-15T10:00:00.000Z',
  granularity: { hours: 1 },
};

const RESPONSE = { summary: [{ clientIp: '1.2.3.4', count_sum: 91 }] };

const LIVE_OBSERVABILITY: ObservabilityBackend = {
  metrics: async () => RESPONSE,
  ruleNames: async () => new Map([['rule_1', 'ja4-denylist']]),
};

const LIVE_CONFIG: LiveConfig = {
  idByName: new Map([['ja4-denylist', 'rule_1']]),
  activeByName: new Map([['ja4-denylist', true]]),
  actionByName: new Map([['ja4-denylist', 'deny']]),
  headerKeysByName: new Map(),
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fw-record-'));
  path = join(dir, 'cassette.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recording observability', () => {
  test('returns exactly what the live call returned', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, path);
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RESPONSE);
  });

  test('writes the response under both keys, so a replay can fall back across windows', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, path);
    await backend.metrics(CTX, ['clientIp'], {});
    const { exact, loose } = metricsKeys(CTX, ['clientIp'], {});
    const loaded = loadCassette(path);
    expect(loaded.entries.get(exact)).toEqual(RESPONSE);
    expect(loaded.loose.get(loose)).toEqual(RESPONSE);
  });

  test('records the rule-name lookup in a form JSON can hold', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, path);
    await backend.ruleNames(CTX);
    expect(loadCassette(path).entries.get(RULE_NAMES_KEY)).toEqual([
      ['rule_1', 'ja4-denylist'],
    ]);
  });

  // A recording session is a LIVE session with a side effect. Losing a line of corpus must never
  // cost the operator the run.
  test('a cassette that cannot be written does not fail the call', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, dir); // a directory, not a file
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RESPONSE);
  });

  test('a live failure still propagates — recording must not swallow it', async () => {
    const failing: ObservabilityBackend = {
      metrics: async () => {
        throw new Error('metrics 429');
      },
      ruleNames: async () => new Map(),
    };
    const backend = recordingObservability(failing, path);
    await expect(backend.metrics(CTX, ['clientIp'], {})).rejects.toThrow(
      'metrics 429',
    );
  });
});

describe('recording the WAF', () => {
  test('records the live config and returns it unchanged', async () => {
    const live: WafBackend = {
      fetchLive: async () => LIVE_CONFIG,
      applyItem: async () => ({ status: 'overwrote' }),
    };
    const backend = recordingWaf(live, path);
    expect(await backend.fetchLive()).toEqual(LIVE_CONFIG);
    expect(loadCassette(path).entries.get(LIVE_CONFIG_KEY)).toMatchObject({
      idByName: [['ja4-denylist', 'rule_1']],
    });
  });

  // Writes are not recorded, and they are not intercepted either: --record applies for real.
  test('the write path is the live one, untouched', () => {
    const applyItem = async (_i: Item) => ({ status: 'inserted' as const });
    const live: WafBackend = { fetchLive: async () => LIVE_CONFIG, applyItem };
    expect(recordingWaf(live, path).applyItem).toBe(applyItem);
  });
});
