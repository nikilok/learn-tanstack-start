// The watch-mode panel under the rules list: whether the loop is running, what the last tick saw,
// and the investigation it produced.

import { Box, Text } from 'ink';

import type { Profiled, Watch } from '../hooks/useWatch';
import { watchTiming } from '../tuning';
import { WATCH_LOG } from '../watch-log';
import { wrappedRows } from './confirm-prompt';

// The panel is about 38 columns wide once the border and padding are taken out, and a JA4 digest
// alone is 37. So the line is ordered by what an operator needs FIRST — verdict, then which
// identity, then volume — because `truncate-end` eats the tail. Ordered the other way round, as it
// was, every row truncated inside the digest: the verdict never appeared at all, and since these
// digests share their profile prefix the rows were indistinguishable from each other.
const SHOWN = 6;

// Eight hex characters of the tail, not twelve: the extra four cost the request count its place on
// the row at the width this panel actually gets, and eight already tells apart every digest that
// will ever be on screen at once. The full value is in the watch list, where enter copies it.
/** Head and tail of a digest. The LAST hash is what distinguishes two digests off one TLS build, so a head-only truncation would show identical rows. */
function shortDigest(d: string): string {
  return d.length <= 20 ? d : `${d.slice(0, 10)}…${d.slice(-8)}`;
}

/** Red for a ban, amber for a challenge — the verdicts that cost something if misread. */
function verdictColour(v: string): string | undefined {
  if (v === 'ban') return 'red';
  if (v === 'challenge') return 'yellow';
  if (v === 'watch') return 'cyan';
  return undefined;
}

/** One judged identity, verdict first. */
function ProfiledRow({ p }: { p: Profiled }) {
  return (
    <Text wrap="truncate-end">
      <Text color={verdictColour(p.verdict)} bold={p.verdict === 'ban'}>
        {'  '}
        {p.verdict}
      </Text>
      <Text dimColor>
        {' · '}
        {shortDigest(p.digest)} · {p.total} req
      </Text>
    </Text>
  );
}

// The only rows whose height is FIXED: two margins and the border's two. Everything else on this
// panel wraps, and every earlier version of this budget assumed one row per logical line —
// header, note, invoked line — then swept at 140 columns where none of them do. They are measured
// by the caller now and passed in, so the arithmetic below cannot silently assume a height again.
const BOX_CHROME = 4;
// The verdict's own heading, and the blank line above it.
const VERDICT_CHROME = 2;

/**
 * Rows to give each list within `maxRows`.
 *
 * Profiles keep their room and the verdict yields, because the verdict already says where its
 * full text is and the profile rows are the only place the current tick's identities appear.
 * Exported so the sizing is tested as arithmetic rather than by counting rendered lines.
 */
export function panelRows(
  maxRows: number,
  profiles: number,
  /** Rows each verdict line costs once wrapped — not a count of lines. */
  verdictCosts: readonly number[],
  /** Rows everything of fixed content costs once wrapped: the box, header, note and status line. */
  fixedRows: number,
  /** Verdict lines useWatch already dropped before this panel saw them. */
  alreadyClipped = 0,
): { profiles: number; verdict: number; overflow: boolean } {
  const room = Math.max(0, maxRows - fixedRows);
  let shownProfiles = Math.min(SHOWN, profiles, room);
  // The "… N more" line costs a row too, and comes out of the SAME room — counted afterwards it
  // pushed the panel one row past the budget it was given.
  if (profiles > shownProfiles && shownProfiles === room)
    shownProfiles = Math.max(0, room - 1);
  // Only when there is a row to spend on it. With no room at all the renderer still drew it,
  // because "are any hidden?" is a different question from "is there space to say so?" — at the
  // floor that alone put the panel one row over.
  const overflow = profiles > shownProfiles && room > 0;
  const left = room - shownProfiles - (overflow ? 1 : 0);
  const budget = left - VERDICT_CHROME;
  // Taken line by line against what each COSTS once wrapped, because a verdict line at this width
  // is regularly two rows. Its own "… N more line(s)" row is reserved only in the case that
  // creates it, not counted as fixed chrome.
  const total = verdictCosts.reduce((a, b) => a + b, 0);
  // The clipped row shows when ANYTHING is missing — including lines useWatch dropped before this
  // panel ever saw them. Reserved only when this panel did the dropping, the row still rendered
  // on a verdict that fit here but had already been cut upstream, one past the budget.
  const reserve = alreadyClipped > 0 ? 1 : 0;
  let verdict = 0;
  if (verdictCosts.length && budget > 0) {
    if (total <= budget - reserve) verdict = verdictCosts.length;
    else {
      let used = 0;
      for (const cost of verdictCosts) {
        if (used + cost > budget - 1) break;
        used += cost;
        verdict++;
      }
    }
  }
  return { profiles: shownProfiles, verdict, overflow };
}

/** Status for an armed watch loop. Renders nothing when it is not. */
export function WatchStatus({
  watch: w,
  /** Rows the panel may occupy. It shrinks to fit rather than growing the column past the viewport — an overflowing frame scrolls the terminal and takes the editor cursor with it. */
  maxRows = Number.MAX_SAFE_INTEGER,
  /** Column width the panel is drawn in. Its note and verdict wrap, so the budget cannot be met without knowing it. */
  width = Number.MAX_SAFE_INTEGER,
}: {
  watch: Watch;
  maxRows?: number;
  width?: number;
}) {
  if (!w.on) return null;
  // The panel's own content width: the column less its border and horizontal padding.
  const inner = Math.max(0, width - 4);
  const timing =
    watchTiming() ??
    'window unset — set FW_WATCH_HOURS and FW_WATCH_INTERVAL_MIN';
  const last = w.at ? ` · last ${w.at}` : ' · starting…';
  const awake = w.keepingAwake ? ' · holding the mac awake' : '';
  // Measured, not assumed: both of these wrap, and at this panel's real width — about 38
  // columns — the loop's own note is three rows. Every earlier version of this budget counted
  // one row per logical line and was swept at 140 columns, where nothing wraps at all.
  const headerWrapped = wrappedRows(`◉ watch ${timing}${last}${awake}`, inner);
  const noteWrapped = w.note ? wrappedRows(w.note, inner) : 0;
  // The invoked line wraps as readily as the other two, and it replaces the logging line rather
  // than joining it — so exactly one of the pair is on screen and only that one is measured.
  const statusText =
    w.invokedCount > 0
      ? `⇢ claude invoked ${w.invokedCount}× this session · last ${w.invokedAt}${w.notifiedAt ? ` · notified ${w.notifiedAt}` : ''} · ${WATCH_LOG}`
      : w.at
        ? `logging to ${WATCH_LOG}`
        : '';
  const statusWrapped = statusText ? wrappedRows(statusText, inner) : 0;
  // Collapsed to one row each ONLY when they genuinely do not fit. Truncating unconditionally
  // cost the header its last-tick time, which is the one thing on that line saying it is alive.
  const full = BOX_CHROME + headerWrapped + noteWrapped + statusWrapped;
  const tight = full > maxRows;
  const fixed = tight
    ? BOX_CHROME + 1 + (w.note ? 1 : 0) + (statusText ? 1 : 0)
    : full;
  const verdictAll = w.verdictHead ? w.verdictHead.split('\n') : [];
  const room = panelRows(
    maxRows,
    w.who.length,
    verdictAll.map((l) => wrappedRows(l, inner)),
    fixed,
    w.verdictClipped,
  );
  const verdictShown = verdictAll.slice(0, room.verdict);
  // Both the lines useWatch already dropped and the ones that did not fit here, or the count
  // understates what is missing and a clipped verdict reads as a complete one.
  const clipped = w.verdictClipped + (verdictAll.length - verdictShown.length);
  return (
    // Boxed so an armed loop reads as its own panel rather than more footer. The border carries
    // the state the ◉ marker already shows — amber mid-tick, green between them — so whether it
    // is working is legible from the shape at the edge of your eye, without reading a word.
    //
    // The background assumes a DARK terminal, which is the only hard-coded assumption of its kind
    // in this tool; every other colour is a named ANSI one that follows the theme. On a light
    // terminal drop `backgroundColor` and the border alone still separates it.
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      paddingX={1}
      borderStyle="round"
      borderColor={w.busy ? 'yellow' : 'green'}
      backgroundColor="#151b23"
    >
      <Text wrap={tight ? 'truncate-end' : 'wrap'}>
        <Text color={w.busy ? 'yellow' : 'green'} bold>
          ◉ watch{' '}
        </Text>
        <Text dimColor>
          {timing}
          {last}
          {awake}
        </Text>
      </Text>
      {Boolean(w.note) && (
        // Wrapped, not truncated: the border costs four columns and this line carries the actual
        // result — "0 profiled · 0 would ban" was the half being clipped away.
        <Text dimColor wrap={tight ? 'truncate-end' : 'wrap'}>
          {w.note}
        </Text>
      )}
      {/* Name them, or "1 profiled" sends the operator digging through the log. */}
      {w.who.slice(0, room.profiles).map((p) => (
        <ProfiledRow key={p.digest} p={p} />
      ))}
      {room.overflow && (
        // Bounded, or a busy tick grows the panel until it pushes the rule list off screen. The
        // watch-list pane has every one of them.
        // truncate-end, so this costs EXACTLY one row. It is short, terse, and the budget
        // cannot keep predicting the height of something that wraps.
        <Text dimColor wrap="truncate-end">
          {'  '}… {w.who.length - room.profiles} more · t for the watch list
        </Text>
      )}
      {/* Stays up once it has happened. The loop runs while you are in another pane, so an
          invocation you were not watching still has to be visible afterwards. */}
      {w.invokedCount > 0 && (
        <Text wrap={tight ? 'truncate-end' : 'wrap'}>
          <Text color="magenta" bold>
            ⇢ claude invoked{' '}
          </Text>
          <Text dimColor>
            {w.invokedCount}× this session · last {w.invokedAt}
            {w.notifiedAt ? ` · notified ${w.notifiedAt}` : ''} · {WATCH_LOG}
          </Text>
        </Text>
      )}
      {w.invokedCount === 0 && Boolean(w.at) && (
        <Text dimColor wrap={tight ? 'truncate-end' : 'wrap'}>
          logging to {WATCH_LOG}
        </Text>
      )}
      {/* Not truncated: a verdict is the one thing here worth reading in full, and a
          clipped one is worse than none — it reads as complete. */}
      {verdictShown.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            investigation{' '}
            {w.verdictOf ? <Text dimColor>{w.verdictOf}</Text> : null}
          </Text>
          {/* Clamped to what the column can actually give it. Measured before this existed: an
              armed panel with six profiles and a verdict came to 26 rows against a frame that
              already filled a 24-row terminal — which scrolls it and takes the editor cursor
              with it, the same defect reportH and the pane height exist to prevent. */}
          <Text>{verdictShown.join('\n')}</Text>
          {clipped > 0 && (
            // One row by construction, for the same reason as the profile overflow line.
            <Text dimColor wrap="truncate-end">
              {'  '}… {clipped} more line(s) — full text in {WATCH_LOG}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
