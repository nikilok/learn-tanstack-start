// The watch list pane: what is being kept an eye on, how long it has been there, and why.
//
// Nothing here is denied — the list is memory, not enforcement. Its job is to make "who was
// that fingerprint again?" a keystroke instead of an archaeology session through the log.

import { ageLabel } from './ip-profile-view';
import { type Line, blank, line, seg } from './line-model';
import type { WatchlistEntry } from './watchlist';

export type WatchlistReport = {
  entries: WatchlistEntry[];
  /** Read failure. The list is UNKNOWN, not empty, and is rendered as exactly that. */
  error?: string;
};

/** One row: kind, id, then how it got here and what the last look concluded. */
function entryLines(e: WatchlistEntry, isCursor: boolean, now: number): Line[] {
  const marker = isCursor ? '▶ ' : '  ';
  const L = [
    line(
      seg(marker, 'key'),
      seg(e.kind.toUpperCase().padEnd(5), 'dim'),
      seg(e.id, isCursor ? 'key' : 'plain'),
    ),
    line(
      seg(
        `       ${e.source === 'watch' ? 'watch mode' : 'marked'} · seen ${e.seen}× · added ${ageLabel(e.addedAt, now)} · last ${ageLabel(e.lastSeen, now)}`,
        'dim',
      ),
    ),
  ];
  if (e.note) L.push(line(seg(`       ${e.note}`, 'dim')));
  return L;
}

/** Full watch list layout. `cursor` indexes `entries`. */
export function watchlistLines(
  r: WatchlistReport,
  cursor: number,
  now: number,
): Line[] {
  const L: Line[] = [
    line(seg('Watch list', 'bold'), seg('  nothing here is denied', 'dim')),
  ];
  // An unreadable list renders as unknown, never as empty: "empty" invites re-adding what may
  // already be there, and the next save would overwrite whatever the file still holds.
  if (r.error) {
    L.push(
      blank(),
      line(seg(`  the list could not be read — ${r.error}`, 'bad')),
      line(
        seg('  entries are withheld and nothing will be saved over it', 'bad'),
      ),
    );
    return L;
  }
  if (!r.entries.length) {
    L.push(
      blank(),
      line(seg('  nothing is being watched', 'good')),
      line(
        seg(
          '  m on an open profile marks it · watch mode adds whatever it profiles',
          'dim',
        ),
      ),
    );
    return L;
  }
  L.push(line(seg(`${r.entries.length} watched`)), blank());
  r.entries.forEach((e, i) => L.push(...entryLines(e, i === cursor, now)));
  return L;
}
