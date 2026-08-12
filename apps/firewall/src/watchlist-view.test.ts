// The dangerous output here is "nothing is being watched" over a file that failed to load —
// an empty-looking list invites re-adding, and the next save overwrites what is still there.

import { describe, expect, test } from 'bun:test';

import { lineText } from './line-model';
import type { WatchlistEntry } from './watchlist';
import { ignoreListLines, watchlistLines } from './watchlist-view';

const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
const NOW = Date.parse('2026-08-12T10:00:00.000Z');

const entry = (over: Partial<WatchlistEntry> = {}): WatchlistEntry => ({
  kind: 'ja4',
  id: DIG,
  addedAt: '2026-08-10T10:00:00.000Z',
  lastSeen: '2026-08-12T09:58:00.000Z',
  seen: 41,
  source: 'watch',
  note: 'leave — matched allow-ch-stream-revalidate (267x)',
  ...over,
});

const text = (entries: WatchlistEntry[], cursor = 0, error?: string) =>
  watchlistLines({ entries, error }, cursor, NOW).map(lineText).join('\n');

describe('watchlistLines', () => {
  test('an entry says how it got here, how often, and what the last look concluded', () => {
    const out = text([entry()]);
    expect(out).toContain(DIG);
    expect(out).toContain('watch mode · seen 41×');
    expect(out).toContain('last 2m ago');
    expect(out).toContain('leave — matched allow-ch-stream-revalidate');
  });

  test('a manual mark reads as marked, not as watch mode', () => {
    expect(text([entry({ source: 'manual', seen: 1 })])).toContain(
      'marked · seen 1×',
    );
  });

  test('the cursor marks exactly one row', () => {
    const rows = text([entry(), entry({ kind: 'ip', id: '192.0.2.7' })], 1);
    expect(rows.match(/▶/g)).toHaveLength(1);
    expect(rows).toContain('▶ IP   192.0.2.7');
  });

  test('empty is a good state and says how to feed the list', () => {
    const out = text([]);
    expect(out).toContain('nothing is being watched');
    expect(out).toContain('m on an open profile');
  });

  test('unreadable NEVER renders as empty', () => {
    const out = text([entry()], 0, 'line 3: kind must be ip or ja4');
    expect(out).not.toContain('nothing is being watched');
    expect(out).not.toContain(DIG); // withheld: a partial list reads as the whole list
    expect(out).toContain('could not be read');
    expect(out).toContain('nothing will be saved over it');
  });
});

// Same rows, opposite meaning — and the same destructive-empty invariant.
describe('ignoreListLines', () => {
  const text = (entries: WatchlistEntry[], cursor = 0, error?: string) =>
    ignoreListLines({ entries, error }, cursor, NOW).map(lineText).join('\n');

  test('reads as muted, never as allowed or denied', () => {
    const out = text([entry({ source: 'manual', seen: 1 })]);
    expect(out).toContain('watch mode skips these');
    expect(out).toContain('the WAF is untouched');
    expect(out).toContain(DIG);
  });

  test('empty is a good state and says how to mute something', () => {
    const out = text([]);
    expect(out).toContain('nothing is ignored');
    expect(out).toContain('z on an open profile');
  });

  test('unreadable NEVER renders as empty', () => {
    const out = text([entry()], 0, 'line 1: missing id');
    expect(out).not.toContain('nothing is ignored');
    expect(out).not.toContain(DIG);
    expect(out).toContain('nothing will be saved over it');
  });
});
