// The watch-mode panel under the rules list: whether the loop is running, what the last tick saw,
// and the investigation it produced.

import { Box, Text } from 'ink';

import type { Profiled, Watch } from '../hooks/useWatch';
import { watchTiming } from '../tuning';
import { WATCH_LOG } from '../watch-log';

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

// What the panel costs before either list: its two margin rows, the border, the header, the note
// and the logging line. The margins count — they are rows in the column like any other, and the
// first version of this budget left them out, so the panel ran two rows past what it was given.
const CHROME = 7;
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
  verdictLines: number,
): { profiles: number; verdict: number; overflow: boolean } {
  const room = Math.max(0, maxRows - CHROME);
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
  // Its own "… N more line(s)" row costs one, and shows exactly when the verdict does not fit —
  // so it has to be reserved in the case that creates it, not counted as fixed chrome.
  const verdict = verdictLines
    ? Math.max(0, Math.min(verdictLines, budget - (verdictLines > budget ? 1 : 0)))
    : 0;
  return { profiles: shownProfiles, verdict, overflow };
}

/** Status for an armed watch loop. Renders nothing when it is not. */
export function WatchStatus({
  watch: w,
  /** Rows the panel may occupy. It shrinks to fit rather than growing the column past the viewport — an overflowing frame scrolls the terminal and takes the editor cursor with it. */
  maxRows = Number.MAX_SAFE_INTEGER,
}: {
  watch: Watch;
  maxRows?: number;
}) {
  if (!w.on) return null;
  const verdictAll = w.verdictHead ? w.verdictHead.split('\n') : [];
  const room = panelRows(maxRows, w.who.length, verdictAll.length);
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
      <Text>
        <Text color={w.busy ? 'yellow' : 'green'} bold>
          ◉ watch{' '}
        </Text>
        <Text dimColor>
          {watchTiming() ??
            'window unset — set FW_WATCH_HOURS and FW_WATCH_INTERVAL_MIN'}
          {w.at ? ` · last ${w.at}` : ' · starting…'}
          {w.keepingAwake ? ' · holding the mac awake' : ''}
        </Text>
      </Text>
      {Boolean(w.note) && (
        // Wrapped, not truncated: the border costs four columns and this line carries the actual
        // result — "0 profiled · 0 would ban" was the half being clipped away.
        <Text dimColor wrap="wrap">
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
        <Text dimColor>
          {'  '}… {w.who.length - room.profiles} more · t for the watch list
        </Text>
      )}
      {/* Stays up once it has happened. The loop runs while you are in another pane, so an
          invocation you were not watching still has to be visible afterwards. */}
      {w.invokedCount > 0 && (
        <Text>
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
        <Text dimColor>logging to {WATCH_LOG}</Text>
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
            <Text dimColor>
              {'  '}… {clipped} more line(s) — full text in {WATCH_LOG}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
