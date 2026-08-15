import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Ctx } from '../observability';
import {
  appendCassette,
  cassetteAgeDays,
  loadCassette,
  metricsKeys,
} from './cassette';

function ctxOver(startTime: string, endTime: string): Ctx {
  return {
    projectId: 'prj',
    teamId: 'team',
    headers: {},
    qs: '',
    startTime,
    endTime,
    granularity: { hours: 1 },
  };
}

// Six hours, recorded at two different times of day.
const MORNING = ctxOver('2026-08-15T04:00:00.000Z', '2026-08-15T10:00:00.000Z');
const EVENING = ctxOver('2026-08-15T14:00:00.000Z', '2026-08-15T20:00:00.000Z');

describe('metricsKeys', () => {
  // The reason the key is derived rather than hashed off the request body: the body carries
  // absolute timestamps, so a cassette would miss every query the minute after it was recorded.
  test('the same query at a different time of day has the same key', () => {
    expect(metricsKeys(MORNING, ['clientIp'], {}).exact).toBe(
      metricsKeys(EVENING, ['clientIp'], {}).exact,
    );
  });

  test('a different window LENGTH is a different query', () => {
    const day = ctxOver('2026-08-14T10:00:00.000Z', '2026-08-15T10:00:00.000Z');
    expect(metricsKeys(MORNING, ['clientIp'], {}).exact).not.toBe(
      metricsKeys(day, ['clientIp'], {}).exact,
    );
  });

  test('but both answer to the same loose key, which is what makes the fallback work', () => {
    const day = ctxOver('2026-08-14T10:00:00.000Z', '2026-08-15T10:00:00.000Z');
    expect(metricsKeys(MORNING, ['clientIp'], {}).loose).toBe(
      metricsKeys(day, ['clientIp'], {}).loose,
    );
  });

  test('the window an option overrides is the one that counts, not the context', () => {
    const overridden = metricsKeys(MORNING, ['clientIp'], {
      startTime: '2026-08-14T10:00:00.000Z',
      endTime: '2026-08-15T10:00:00.000Z',
    });
    const day = ctxOver('2026-08-14T10:00:00.000Z', '2026-08-15T10:00:00.000Z');
    expect(overridden.exact).toBe(metricsKeys(day, ['clientIp'], {}).exact);
  });

  test('granularity separates two queries over the same window', () => {
    expect(
      metricsKeys(MORNING, ['clientIp'], { granularity: { minutes: 5 } }).exact,
    ).not.toBe(metricsKeys(MORNING, ['clientIp'], {}).exact);
  });

  test.each([
    ['event', { event: 'firewallAction' }],
    ['filter', { filter: "clientIp eq '1.2.3.4'" }],
    ['limit', { limit: 25 }],
  ])('%s separates two queries', (_label, opts) => {
    expect(metricsKeys(MORNING, ['clientIp'], opts).exact).not.toBe(
      metricsKeys(MORNING, ['clientIp'], {}).exact,
    );
  });

  test('group order is part of the query, since the response columns follow it', () => {
    expect(metricsKeys(MORNING, ['clientIp', 'wafAction'], {}).exact).not.toBe(
      metricsKeys(MORNING, ['wafAction', 'clientIp'], {}).exact,
    );
  });

  test('a filter carrying the key separator does not collide with another query', () => {
    const piped = metricsKeys(MORNING, ['requestPath'], {
      filter: "requestPath eq '/a|b|500'",
    });
    expect(piped.exact).not.toBe(
      metricsKeys(MORNING, ['requestPath'], {}).exact,
    );
  });
});

describe('the cassette file', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fw-cassette-'));
    path = join(dir, 'cassette.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a missing file is an empty corpus, not a failure', () => {
    const loaded = loadCassette(join(dir, 'absent.jsonl'));
    expect(loaded.entries.size).toBe(0);
    expect(loaded.skipped).toBe(0);
  });

  test('round-trips a response under both its keys', () => {
    appendCassette(path, 'exact-key', { summary: [{ count: 3 }] }, 'loose-key');
    const loaded = loadCassette(path);
    expect(loaded.entries.get('exact-key')).toEqual({
      summary: [{ count: 3 }],
    });
    expect(loaded.loose.get('loose-key')).toEqual({ summary: [{ count: 3 }] });
  });

  // Re-recording is how a stale corpus is refreshed, and the file is append-only.
  test('a later recording of the same query wins', () => {
    appendCassette(path, 'k', { summary: [{ count: 1 }] }, 'l');
    appendCassette(path, 'k', { summary: [{ count: 2 }] }, 'l');
    const loaded = loadCassette(path);
    expect(loaded.entries.get('k')).toEqual({ summary: [{ count: 2 }] });
    expect(loaded.loose.get('l')).toEqual({ summary: [{ count: 2 }] });
  });

  // What a crash mid-record leaves behind. The rest of the corpus is still good.
  test('a truncated last line is counted, not thrown, and the rest still loads', () => {
    appendCassette(path, 'good', { summary: [] }, 'loose');
    writeFileSync(path, `${'{"k":"half'}`, { flag: 'a' });
    const loaded = loadCassette(path);
    expect(loaded.entries.has('good')).toBe(true);
    expect(loaded.skipped).toBe(1);
  });

  test('a line with no key is skipped rather than stored under undefined', () => {
    writeFileSync(path, '{"v":{"summary":[]}}\n');
    const loaded = loadCassette(path);
    expect(loaded.entries.size).toBe(0);
    expect(loaded.skipped).toBe(1);
  });

  test('an entry recorded without a loose key stays out of the fallback index', () => {
    appendCassette(path, 'k', { summary: [] });
    const loaded = loadCassette(path);
    expect(loaded.entries.size).toBe(1);
    expect(loaded.loose.size).toBe(0);
  });
});

describe('cassetteAgeDays', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fw-age-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('an absent cassette has no age, which is not the same as a fresh one', () => {
    expect(cassetteAgeDays(join(dir, 'absent.jsonl'))).toBeUndefined();
  });

  test('reports whole days since it was last written', () => {
    const path = join(dir, 'c.jsonl');
    appendCassette(path, 'k', {}, 'l');
    // Built from the same whole-millisecond value the helper reads, or the sub-millisecond part
    // of mtimeMs lands the difference just short of 31 days and it floors to 30.
    const written = Math.floor(statSync(path).mtimeMs);
    const later = new Date(written + 31 * 24 * 60 * 60 * 1000);
    expect(cassetteAgeDays(path, later)).toBe(31);
  });

  test('a cassette written moments ago is zero days old, not undefined', () => {
    const path = join(dir, 'c.jsonl');
    appendCassette(path, 'k', {}, 'l');
    expect(cassetteAgeDays(path)).toBe(0);
  });
});
