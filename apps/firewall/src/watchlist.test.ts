// The dangerous failure here is destructive: a list that could not be read must never be saved
// over, because the save is what turns one bad parse into a lost curation.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IGNORELIST_FILE,
  WATCHLIST_FILE,
  type WatchAddition,
  type WatchlistEntry,
  formatWatchlist,
  parseWatchlist,
  readList,
  recordAdditions,
  recordExclusive,
  removeEntry,
  upsertEntry,
} from './watchlist';

const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
const OTHER = 't13dothr00_111111111111_222222222222';
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
    const parsed = parseWatchlist(formatWatchlist([e]), WATCHLIST_FILE);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toEqual([
      { ...e, note: 'leave — matched rule (267x)   first-party' },
    ]);
  });

  test('blank lines are skipped, so a hand-edited file stays valid', () => {
    const parsed = parseWatchlist(
      `\n${formatWatchlist([entry()])}\n\n`,
      WATCHLIST_FILE,
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toHaveLength(1);
  });

  test('one malformed line refuses the WHOLE file and names file and line', () => {
    // A partial load that later saves is how a hand edit gets silently destroyed. The file is
    // named because there are two of these now, and "line 2" alone sends you to the wrong one.
    const parsed = parseWatchlist(
      `${formatWatchlist([entry()])}garbage\n`,
      IGNORELIST_FILE,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.entries).toEqual([]);
    expect(parsed.error).toContain(`${IGNORELIST_FILE} line 2`);
  });

  test('a padded field is trimmed, so a hand-edited entry still MATCHES', () => {
    // The whole point of these files is suppression, and an id with a stray space passes every
    // check here and then matches no digest off the API — so the entry silently fails to suppress
    // what it was added for. Costlier on the ignore list, where the miss buys ~21 queries and,
    // unattended, a paid investigation.
    const raw = `ja4| ${DIG} |2026-08-06T00:00:00.000Z|2026-08-06T00:00:00.000Z| 3 | watch |n`;
    const out = parseWatchlist(raw, '.firewall-watchlist');
    expect(out.ok).toBe(true);
    expect(out.entries[0]?.id).toBe(DIG);
    expect(out.entries[0]?.seen).toBe(3);
    expect(out.entries[0]?.source).toBe('watch');
  });

  test('a JA4 id is normalised to lower case on the way in', () => {
    const raw = formatWatchlist([entry()]).replace(DIG, DIG.toUpperCase());
    expect(parseWatchlist(raw, WATCHLIST_FILE).entries[0]?.id).toBe(DIG);
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

describe('readList / recordAdditions', () => {
  test('a missing file is an empty list, ok', async () => {
    expect(await readList(tmp(), WATCHLIST_FILE)).toEqual({
      entries: [],
      ok: true,
    });
  });

  test('recording twice accumulates on disk, deduped', async () => {
    const dir = tmp();
    const add = [
      { kind: 'ja4' as const, id: DIG, source: 'watch' as const, note: 'n1' },
    ];
    expect(
      (await recordAdditions(dir, WATCHLIST_FILE, add, AT)).error,
    ).toBeUndefined();
    const { entries } = await recordAdditions(dir, WATCHLIST_FILE, add, LATER);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.seen).toBe(2);
    expect((await readList(dir, WATCHLIST_FILE)).entries?.[0]?.seen).toBe(2);
  });

  test('a corrupt file is reported and NEVER written over', async () => {
    const dir = tmp();
    writeFileSync(join(dir, WATCHLIST_FILE), 'not|a|valid|line\n', 'utf8');
    const out = await recordAdditions(
      dir,
      WATCHLIST_FILE,
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
    expect(await recordAdditions(dir, WATCHLIST_FILE, [], AT)).toEqual({});
    expect((await readList(dir, WATCHLIST_FILE)).entries).toEqual([]);
  });

  test('a successful save leaves no temp file behind', async () => {
    const dir = tmp();
    await recordAdditions(
      dir,
      WATCHLIST_FILE,
      [{ kind: 'ja4', id: DIG, source: 'watch', note: '' }],
      AT,
    );
    expect(readdirSync(dir)).toEqual([WATCHLIST_FILE]);
  });

  test('a failed save reports and leaves the existing list untouched', async () => {
    // Root ignores directory permissions, so this scenario cannot be staged there.
    if (process.getuid?.() === 0) return;
    const dir = tmp();
    await recordAdditions(
      dir,
      WATCHLIST_FILE,
      [{ kind: 'ja4', id: DIG, source: 'watch', note: 'original' }],
      AT,
    );
    const before = readFileSync(join(dir, WATCHLIST_FILE), 'utf8');
    chmodSync(dir, 0o555);
    try {
      const out = await recordAdditions(
        dir,
        WATCHLIST_FILE,
        [{ kind: 'ja4', id: OTHER, source: 'watch', note: 'new' }],
        LATER,
      );
      expect(out.error).toBeTruthy();
      expect(out.entries).toBeUndefined();
    } finally {
      chmodSync(dir, 0o755);
    }
    // The write-then-rename means the original survives the failure byte for byte.
    expect(readFileSync(join(dir, WATCHLIST_FILE), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual([WATCHLIST_FILE]);
  });

  test('the two lists are separate files that never bleed into each other', async () => {
    const dir = tmp();
    const add = (id: string) => [
      { kind: 'ja4' as const, id, source: 'manual' as const, note: '' },
    ];
    await recordAdditions(dir, WATCHLIST_FILE, add(DIG), AT);
    await recordAdditions(dir, IGNORELIST_FILE, add(OTHER), AT);
    expect((await readList(dir, WATCHLIST_FILE)).entries[0]?.id).toBe(DIG);
    expect((await readList(dir, IGNORELIST_FILE)).entries[0]?.id).toBe(OTHER);
  });
});

describe('recordExclusive', () => {
  const add = [
    { kind: 'ja4' as const, id: DIG, source: 'manual' as const, note: 'z' },
  ];

  test('lands on the target list and leaves the other, so no identity holds both meanings', async () => {
    const dir = tmp();
    await recordAdditions(dir, WATCHLIST_FILE, add, AT); // starts watched
    const out = await recordExclusive(
      dir,
      IGNORELIST_FILE,
      WATCHLIST_FILE,
      add,
      LATER,
    );
    expect(out.error).toBeUndefined();
    expect(out.added?.map((e) => e.id)).toEqual([DIG]);
    expect(out.remaining).toEqual([]);
    expect((await readList(dir, WATCHLIST_FILE)).entries).toEqual([]);
    expect((await readList(dir, IGNORELIST_FILE)).entries[0]?.id).toBe(DIG);
  });

  test('adding when the other list never held it does not rewrite the other file', async () => {
    const dir = tmp();
    const out = await recordExclusive(
      dir,
      IGNORELIST_FILE,
      WATCHLIST_FILE,
      add,
      AT,
    );
    expect(out.error).toBeUndefined();
    // The drop side stayed absent: nothing manufactured an empty file to overwrite later.
    expect(() => readFileSync(join(dir, WATCHLIST_FILE), 'utf8')).toThrow();
  });

  // The operator's keystrokes and the watch tick both write these files, in ONE process, each
  // across an await. Interleaved, the later write is built on a read taken before the earlier
  // one landed, so the earlier edit is silently gone — a curated entry that vanishes with no
  // error anywhere.
  test('a concurrent record does not overwrite one already in flight', async () => {
    const dir = tmp();
    const one: WatchAddition[] = [
      { kind: 'ja4', id: DIG, source: 'watch', note: 'first' },
    ];
    const two: WatchAddition[] = [
      { kind: 'ja4', id: OTHER, source: 'watch', note: 'second' },
    ];
    const [a, b] = await Promise.all([
      recordAdditions(dir, WATCHLIST_FILE, one, AT),
      recordAdditions(dir, WATCHLIST_FILE, two, AT),
    ]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const ids = (await readList(dir, WATCHLIST_FILE)).entries.map((e) => e.id);
    expect(ids.sort()).toEqual([DIG, OTHER].sort());
  });

  test('a concurrent move and record both survive', async () => {
    const dir = tmp();
    const moved: WatchAddition[] = [
      { kind: 'ja4', id: DIG, source: 'manual', note: 'ignore' },
    ];
    const ticked: WatchAddition[] = [
      { kind: 'ja4', id: OTHER, source: 'watch', note: 'seen' },
    ];
    await Promise.all([
      recordExclusive(dir, IGNORELIST_FILE, WATCHLIST_FILE, moved, AT),
      recordAdditions(dir, IGNORELIST_FILE, ticked, AT),
    ]);
    const ids = (await readList(dir, IGNORELIST_FILE)).entries.map((e) => e.id);
    expect(ids.sort()).toEqual([DIG, OTHER].sort());
  });

  test('refuses when EITHER side is unreadable — a half-move leaves both meanings live', async () => {
    const dir = tmp();
    writeFileSync(join(dir, WATCHLIST_FILE), 'garbage\n', 'utf8');
    const out = await recordExclusive(
      dir,
      IGNORELIST_FILE,
      WATCHLIST_FILE,
      add,
      AT,
    );
    expect(out.error).toContain('nothing recorded');
    expect(out.added).toBeUndefined();
    // Neither file was touched: the corrupt one survives, the target was never created.
    expect(readFileSync(join(dir, WATCHLIST_FILE), 'utf8')).toBe('garbage\n');
    expect(() => readFileSync(join(dir, IGNORELIST_FILE), 'utf8')).toThrow();
  });
});
