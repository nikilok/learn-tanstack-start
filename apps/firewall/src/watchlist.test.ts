// The dangerous failure here is destructive: a list that could not be read must never be saved
// over, because the save is what turns one bad parse into a lost curation.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WATCHLIST_FILE,
  type WatchlistEntry,
  formatWatchlist,
  parseWatchlist,
  readWatchlist,
  recordAdditions,
  removeEntry,
  upsertEntry,
} from './watchlist';

const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
const AT = new Date('2026-08-12T10:00:00.000Z');
const LATER = new Date('2026-08-12T11:00:00.000Z');

const entry = (over: Partial<WatchlistEntry> = {}): WatchlistEntry => ({
  kind: 'ja4',
  id: DIG,
  addedAt: AT.toISOString(),
  lastSeen: AT.toISOString(),
  seen: 1,
  source: 'watch',
  note: 'leave — first-party caller',
  ...over,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fw-watchlist-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('parseWatchlist / formatWatchlist', () => {
  test('round-trips entries, including a note containing pipes', () => {
    const e = entry({ note: 'leave — matched rule (267x) | first-party' });
    const parsed = parseWatchlist(formatWatchlist([e]));
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toEqual([
      { ...e, note: 'leave — matched rule (267x)   first-party' },
    ]);
  });

  test('blank lines are skipped, so a hand-edited file stays valid', () => {
    const parsed = parseWatchlist(`\n${formatWatchlist([entry()])}\n\n`);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toHaveLength(1);
  });

  test('one malformed line refuses the WHOLE file and says which line', () => {
    // A partial load that later saves is how a hand edit gets silently destroyed.
    const parsed = parseWatchlist(`${formatWatchlist([entry()])}garbage\n`);
    expect(parsed.ok).toBe(false);
    expect(parsed.entries).toEqual([]);
    expect(parsed.error).toContain('line 2');
  });

  test('a JA4 id is normalised to lower case on the way in', () => {
    const raw = formatWatchlist([entry()]).replace(DIG, DIG.toUpperCase());
    expect(parseWatchlist(raw).entries[0]?.id).toBe(DIG);
  });
});

describe('upsertEntry', () => {
  test('a new identity arrives with seen 1 and both timestamps set', () => {
    const [e] = upsertEntry(
      [],
      { kind: 'ja4', id: DIG.toUpperCase(), source: 'watch', note: 'n' },
      AT,
    );
    expect(e).toEqual(entry({ note: 'n' }));
  });

  test('re-recording bumps seen and lastSeen but keeps addedAt', () => {
    const [e] = upsertEntry(
      [entry()],
      { kind: 'ja4', id: DIG, source: 'watch', note: 'newer note' },
      LATER,
    );
    expect(e.seen).toBe(2);
    expect(e.addedAt).toBe(AT.toISOString());
    expect(e.lastSeen).toBe(LATER.toISOString());
    expect(e.note).toBe('newer note');
  });

  test('a manual mark is never demoted back to watch', () => {
    const marked = upsertEntry(
      [entry()],
      { kind: 'ja4', id: DIG, source: 'manual', note: '' },
      LATER,
    );
    expect(marked[0]?.source).toBe('manual');
    // The note survives an empty re-record rather than being blanked.
    expect(marked[0]?.note).toBe('leave — first-party caller');
    const rewatched = upsertEntry(
      marked,
      { kind: 'ja4', id: DIG, source: 'watch', note: 'auto again' },
      LATER,
    );
    expect(rewatched[0]?.source).toBe('manual');
  });

  test('the same digest in different case is one identity, an IP is compared as written', () => {
    expect(
      upsertEntry(
        [entry()],
        { kind: 'ja4', id: DIG.toUpperCase(), source: 'watch', note: '' },
        LATER,
      ),
    ).toHaveLength(1);
    expect(
      upsertEntry(
        [entry({ kind: 'ip', id: '192.0.2.7' })],
        { kind: 'ip', id: '192.0.2.8', source: 'manual', note: '' },
        LATER,
      ),
    ).toHaveLength(2);
  });

  test('notes are flattened to one bounded line whatever a verdict contains', () => {
    const [e] = upsertEntry(
      [],
      {
        kind: 'ja4',
        id: DIG,
        source: 'watch',
        note: `a|b\nc\r${'x'.repeat(400)}`,
      },
      AT,
    );
    expect(e.note).not.toMatch(/[|\r\n]/);
    expect(e.note.length).toBeLessThanOrEqual(300);
  });
});

describe('removeEntry', () => {
  test('drops exactly the named identity, case-insensitively for JA4', () => {
    const other = entry({ kind: 'ip', id: '192.0.2.7' });
    expect(removeEntry([entry(), other], 'ja4', DIG.toUpperCase())).toEqual([
      other,
    ]);
  });
});

describe('readWatchlist / recordAdditions', () => {
  test('a missing file is an empty list, ok', async () => {
    expect(await readWatchlist(tmp())).toEqual({ entries: [], ok: true });
  });

  test('recording twice accumulates on disk, deduped', async () => {
    const dir = tmp();
    const add = [
      { kind: 'ja4' as const, id: DIG, source: 'watch' as const, note: 'n1' },
    ];
    expect((await recordAdditions(dir, add, AT)).error).toBeUndefined();
    const { entries } = await recordAdditions(dir, add, LATER);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.seen).toBe(2);
    expect((await readWatchlist(dir)).entries?.[0]?.seen).toBe(2);
  });

  test('a corrupt file is reported and NEVER written over', async () => {
    const dir = tmp();
    writeFileSync(join(dir, WATCHLIST_FILE), 'not|a|valid|line\n', 'utf8');
    const out = await recordAdditions(
      dir,
      [{ kind: 'ja4', id: DIG, source: 'watch', note: '' }],
      AT,
    );
    expect(out.error).toContain('nothing recorded');
    expect(out.entries).toBeUndefined();
    expect(readFileSync(join(dir, WATCHLIST_FILE), 'utf8')).toBe(
      'not|a|valid|line\n',
    );
  });

  test('nothing to add means nothing is read or written', async () => {
    const dir = tmp();
    expect(await recordAdditions(dir, [], AT)).toEqual({});
    expect((await readWatchlist(dir)).entries).toEqual([]);
  });
});
