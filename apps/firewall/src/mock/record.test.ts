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
import {
  type RecordingStats,
  recordingObservability,
  recordingWaf,
} from './record';

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

/** A fresh counter per call, for the tests that do not assert on it. */
const stats = () => ({ written: 0, failed: 0 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fw-record-'));
  path = join(dir, 'cassette.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recording observability', () => {
  test('returns exactly what the live call returned', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, path, stats());
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RESPONSE);
  });

  test('writes the response under both keys, so a replay can fall back across windows', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, path, stats());
    await backend.metrics(CTX, ['clientIp'], {});
    const { exact, loose } = metricsKeys(CTX, ['clientIp'], {});
    const loaded = loadCassette(path);
    expect(loaded.entries.get(exact)).toEqual(RESPONSE);
    expect(loaded.loose.get(loose)).toEqual(RESPONSE);
  });

  test('records the rule-name lookup in a form JSON can hold', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, path, stats());
    await backend.ruleNames(CTX);
    expect(loadCassette(path).entries.get(RULE_NAMES_KEY)).toEqual([
      ['rule_1', 'ja4-denylist'],
    ]);
  });

  // A recording session is a LIVE session with a side effect. Losing a line of corpus must never
  // cost the operator the run.
  test('a cassette that cannot be written does not fail the call', async () => {
    const backend = recordingObservability(LIVE_OBSERVABILITY, dir, stats()); // a directory, not a file
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RESPONSE);
  });

  test('a live failure still propagates — recording must not swallow it', async () => {
    const failing: ObservabilityBackend = {
      metrics: async () => {
        throw new Error('metrics 429');
      },
      ruleNames: async () => new Map(),
    };
    const backend = recordingObservability(failing, path, stats());
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
    const backend = recordingWaf(live, path, stats());
    expect(await backend.fetchLive()).toEqual(LIVE_CONFIG);
    expect(loadCassette(path).entries.get(LIVE_CONFIG_KEY)).toMatchObject({
      idByName: [['ja4-denylist', 'rule_1']],
    });
  });

  // A recording captures READS. It is still a live TUI with the apply key live, and an apply
  // fired during one from a stray keystroke during this repo's own development — so the write
  // path is refused rather than passed through.
  test('the write path is refused, never reaching the live one', async () => {
    let reached = false;
    const live: WafBackend = {
      fetchLive: async () => LIVE_CONFIG,
      applyItem: async () => {
        reached = true;
        return { status: 'inserted' as const };
      },
    };
    const backend = recordingWaf(live, path, stats());
    const result = await backend.applyItem({} as Item, new Map());
    expect(reached).toBe(false);
    expect(result.status).toBe('error');
    expect(result.detail).toContain('read-only');
  });
});

describe('what the recording managed to write', () => {
  // A session where every append failed used to report success and produce nothing — the same
  // silent-nothing the version guard exists to prevent at the other end.
  test('counts the writes that landed', async () => {
    const counter = { written: 0, failed: 0 };
    const backend = recordingObservability(LIVE_OBSERVABILITY, path, counter);
    await backend.metrics(CTX, ['clientIp'], {});
    await backend.ruleNames(CTX);
    expect(counter).toEqual({ written: 2, failed: 0 });
  });

  test('counts the ones that could not be written', async () => {
    const counter = { written: 0, failed: 0 };
    // A directory, so every append throws.
    const backend = recordingObservability(LIVE_OBSERVABILITY, dir, counter);
    await backend.metrics(CTX, ['clientIp'], {});
    await backend.metrics(CTX, ['requestPath'], {});
    expect(counter.written).toBe(0);
    expect(counter.failed).toBe(2);
  });

  // A count alone says a recording is incomplete without saying what to fix.
  test('keeps why the first one failed', async () => {
    const counter: RecordingStats = { written: 0, failed: 0 };
    const backend = recordingObservability(LIVE_OBSERVABILITY, dir, counter);
    await backend.metrics(CTX, ['clientIp'], {});
    await backend.metrics(CTX, ['requestPath'], {});
    expect(counter.firstError).toContain('EISDIR');
  });

  test('and keeps the FIRST one, not the last', async () => {
    const counter = { written: 0, failed: 0, firstError: 'the original' };
    const backend = recordingObservability(LIVE_OBSERVABILITY, dir, counter);
    await backend.metrics(CTX, ['clientIp'], {});
    expect(counter.firstError).toBe('the original');
  });

  test('a failed write still returns the live response', async () => {
    const counter = { written: 0, failed: 0 };
    const backend = recordingObservability(LIVE_OBSERVABILITY, dir, counter);
    expect(await backend.metrics(CTX, ['clientIp'], {})).toEqual(RESPONSE);
  });

  test('the WAF read is counted too', async () => {
    const counter = { written: 0, failed: 0 };
    const backend = recordingWaf(
      {
        fetchLive: async () => LIVE_CONFIG,
        applyItem: async () => ({ status: 'overwrote' }),
      },
      path,
      counter,
    );
    await backend.fetchLive();
    expect(counter.written).toBe(1);
  });
});
