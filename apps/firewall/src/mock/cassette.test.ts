import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Ctx } from '../observability';
import {
  CASSETTE_VERSION,
  UNVERSIONED,
  appendCassette,
  cassetteAgeDays,
  ensureOwnerOnly,
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

  // Declined in an earlier round as unreachable (every construction site builds a single-key
  // object). The JSON key rework made canonicalising free, so the class is closed rather than
  // argued about.
  test('two equivalent granularities key the same however they were built', () => {
    const a = metricsKeys(MORNING, ['clientIp'], {
      granularity: { hours: 1, minutes: 5 },
    });
    const b = metricsKeys(MORNING, ['clientIp'], {
      granularity: { minutes: 5, hours: 1 },
    });
    expect(a.exact).toBe(b.exact);
  });

  // Granularity is the BUCKET SIZE. A 10-minute-bucket query answered from an hourly recording
  // gets a series whose points mean something else, and the session shape is computed off it.
  test('the live window does not fall back to an hourly recording', () => {
    const live = metricsKeys(MORNING, ['clientIp'], {
      granularity: { minutes: 10 },
    });
    const hourly = metricsKeys(MORNING, ['clientIp'], {
      granularity: { hours: 1 },
    });
    expect(live.loose).not.toBe(hourly.loose);
  });

  // ...while the substitution the fallback exists for still works: every window from 1h up is
  // hourly, so a 6h recording still answers a 24h query.
  test('two hourly windows of different lengths still share a loose key', () => {
    const six = metricsKeys(MORNING, ['clientIp'], {});
    const day = metricsKeys(
      ctxOver('2026-08-14T10:00:00.000Z', '2026-08-15T10:00:00.000Z'),
      ['clientIp'],
      {},
    );
    expect(six.loose).toBe(day.loose);
    expect(six.exact).not.toBe(day.exact);
  });

  // The filter is the one free-form field and it carries request paths, which are client-supplied.
  test('a filter cannot be confused with the field after it', () => {
    const packed = metricsKeys(MORNING, ['clientIp'], {
      filter: 'x|25',
      limit: 500,
    });
    const split = metricsKeys(MORNING, ['clientIp'], {
      filter: 'x',
      limit: 25,
    });
    expect(packed.exact).not.toBe(split.exact);
    expect(packed.loose).not.toBe(split.loose);
  });

  test('a filter cannot be confused with the group list before it', () => {
    const a = metricsKeys(MORNING, ['clientIp'], { filter: 'wafAction' });
    const b = metricsKeys(MORNING, ['clientIp', 'wafAction'], {});
    expect(a.exact).not.toBe(b.exact);
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

  // A key with nothing behind it used to be STORED, so has() said yes, the replay handed back
  // undefined, and the first reader to touch .summary threw. A truncated line took out a pane.
  test.each([
    ['no value at all', '{"k":"orphan"}'],
    ['a null value', '{"k":"orphan","v":null}'],
  ])('a row with %s is skipped, not stored', (_label, line) => {
    writeFileSync(path, `${line}\n`);
    const loaded = loadCassette(path);
    expect(loaded.entries.has('orphan')).toBe(false);
    expect(loaded.skipped).toBe(1);
  });

  // A corpus copied in from the ops repo arrives with whatever mode it had, and copying one in is
  // a documented workflow. appendCassette's create-mode does not cover a file it did not create.
  test('tightens an existing world-readable cassette', () => {
    writeFileSync(path, '{"k":"a","v":1}\n');
    chmodSync(path, 0o644);
    ensureOwnerOnly(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('creates the cassette when it is not there yet', () => {
    ensureOwnerOnly(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadCassette(path).entries.size).toBe(0);
  });

  test('leaves what is already recorded alone', () => {
    appendCassette(path, 'k', { summary: [] }, 'l');
    ensureOwnerOnly(path);
    expect(loadCassette(path).entries.has('k')).toBe(true);
  });

  // The corpus is real client IPs and TLS fingerprints; 0644 is every account on the machine.
  test('creates the cassette readable only by its owner', () => {
    appendCassette(path, 'k', { summary: [] }, 'l');
    expect(statSync(path).mode & 0o777).toBe(0o600);
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

describe('the version header', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fw-ver-'));
    path = join(dir, 'c.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a cassette this build creates declares its format', () => {
    ensureOwnerOnly(path);
    expect(loadCassette(path).version).toBe(CASSETTE_VERSION);
  });

  test('the header survives the entries appended after it', () => {
    ensureOwnerOnly(path);
    appendCassette(path, 'k', { summary: [] }, 'l');
    const loaded = loadCassette(path);
    expect(loaded.version).toBe(CASSETTE_VERSION);
    expect(loaded.entries.has('k')).toBe(true);
    expect(loaded.skipped).toBe(0);
  });

  // Recorded before versioning existed. Its keys cannot be assumed to mean anything.
  test('a cassette with no header reads as unversioned', () => {
    writeFileSync(path, '{"k":"a","v":1}\n');
    const loaded = loadCassette(path);
    expect(loaded.version).toBe(UNVERSIONED);
    expect(loaded.entries.has('a')).toBe(true);
  });

  test('a future format is reported as itself, not clamped', () => {
    writeFileSync(path, '{"cassette":99}\n{"k":"a","v":1}\n');
    expect(loadCassette(path).version).toBe(99);
  });

  // The header is not an entry, and an entry is not a header.
  test('the header is not counted as a skipped line', () => {
    ensureOwnerOnly(path);
    expect(loadCassette(path).skipped).toBe(0);
  });

  test('a first line that is an entry is kept as one', () => {
    writeFileSync(path, '{"k":"first","v":1}\n{"k":"second","v":2}\n');
    expect(loadCassette(path).entries.size).toBe(2);
  });
});

describe('a cassette must be a regular file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fw-link-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // chmod and append both act on the TARGET, so a link planted at the cassette path would have
  // this tool rewrite the permissions of, and append JSON into, a file somewhere else.
  test('refuses to write through a symlink', () => {
    const target = join(dir, 'somebody-elses-file');
    writeFileSync(target, 'important\n');
    chmodSync(target, 0o644);
    const link = join(dir, 'innocent.jsonl');
    symlinkSync(target, link);
    expect(() => ensureOwnerOnly(link)).toThrow('symlink');
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(target, 'utf8')).toBe('important\n');
  });

  test('a plain new cassette is still fine', () => {
    const path = join(dir, 'fine.jsonl');
    expect(() => ensureOwnerOnly(path)).not.toThrow();
    expect(loadCassette(path).version).toBe(CASSETTE_VERSION);
  });
});
