// The IP/JA4 picker overlay: the busiest list, the quiet band beside it, and the input line.

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import type { Pickers } from '../hooks/usePickers';
import { CAP_BUSIEST, CAP_QUIET, TOP_IPS_LIMIT } from '../hooks/usePickers';
import { PANE_GAP } from '../pane-layout';
import type { Window } from '../time-window';

export function IdentityPicker({
  pickers,
  window: ipWindow,
  isLive,
  refreshSeconds,
  backingOff,
  openAllMax,
  twoCol,
  row,
}: {
  pickers: Pickers;
  window: Window;
  isLive: boolean;
  refreshSeconds: number;
  backingOff: boolean;
  openAllMax: number;
  /** Whether the quiet band fits beside the busiest column at this width. */
  twoCol: boolean;
  /** One picker row. `i` indexes pickers.pickable, so the cursor means the same in both columns. */
  row: (r: [string, number], i: number) => ReactNode;
}) {
  return (
    <Box flexDirection="column">
      {pickers.list.loading && !pickers.list.data ? (
        // truncate-end like the error branch beside it: the pane reserves ONE row for this
        // header, and at a narrow width an untruncated one wraps into the rows meant for the list.
        <Text dimColor wrap="truncate-end">
          {'  '}loading busiest {pickers.kind === 'ip' ? 'IPs' : 'fingerprints'}
          … (up to ~90s — the endpoint retries a timeout twice)
        </Text>
      ) : pickers.list.error ? (
        // Said out loud. The endpoint intermittently answers 504 Query timed out, and
        // the spinner used to simply vanish after ~90s leaving an empty pane — which
        // reads as a broken tool rather than as an upstream failure you can retry.
        <Text color="red" wrap="truncate-end">
          {'  '}
          {pickers.kind === 'ip' ? 'IP' : 'fingerprint'} list failed:{' '}
          {pickers.list.error} · esc then {pickers.kind === 'ip' ? 'i' : 'f'}{' '}
          retries · typing an id and pressing enter still works
        </Text>
      ) : (
        pickers.list.data && (
          // One row, like the other two branches. This is the longest header of the three and
          // the one on screen for the whole session.
          <Text dimColor wrap="truncate-end">
            {'  '}busiest {pickers.kind === 'ip' ? 'IPs' : 'JA4 fingerprints'} ·{' '}
            {ipWindow.label} ·{' '}
            {pickers.input
              ? `${pickers.filtered.length} match` +
                (pickers.filtered.length > pickers.busiest.length
                  ? `, showing ${pickers.busiest.length}`
                  : '')
              : `top ${pickers.busiest.length} of ${pickers.list.data.length}` +
                // A full list means the API's group cap was reached, and it truncates
                // silently. The quiet band is drawn from the bottom of what came back,
                // which is then not the bottom of the traffic — say so rather than let
                // a partial answer read as the whole picture.
                (pickers.list.data.length >= TOP_IPS_LIMIT ? ' (capped)' : '') +
                (isLive
                  ? ` · auto-refresh ${refreshSeconds}s${backingOff ? ' (backing off)' : ''}`
                  : ', type to filter') +
                // Names the bound rather than saying "all": the list above can now be
                // longer than what one keypress will open.
                ` · o open top ${Math.min(openAllMax, pickers.busiest.length)} · w timeline`}
          </Text>
        )
      )}
      {twoCol ? (
        <Box>
          <Box flexDirection="column" marginRight={PANE_GAP}>
            <Text dimColor>
              {'  '}
              {CAP_BUSIEST}
            </Text>
            {pickers.busiest.map(row)}
          </Box>
          <Box flexDirection="column">
            <Text dimColor>
              {'  '}
              {CAP_QUIET}
            </Text>
            {pickers.quiet.map((r, i) => row(r, pickers.busiest.length + i))}
          </Box>
        </Box>
      ) : (
        <>
          {pickers.busiest.map(row)}
          {pickers.quiet.length > 0 && (
            <Text dimColor>
              {'  '}
              {CAP_QUIET} requests, lowest first
            </Text>
          )}
          {pickers.quiet.map((r, i) => row(r, pickers.busiest.length + i))}
        </>
      )}
      {Boolean(pickers.list.data) &&
        !pickers.busiest.length &&
        pickers.input && (
          <Text dimColor>
            {' '}
            no busy {pickers.kind === 'ip' ? 'IP' : 'fingerprint'} matches —
            enter profiles it anyway
          </Text>
        )}
      <Box>
        <Text color="cyan">{pickers.kind === 'ip' ? 'IP: ' : 'JA4: '}</Text>
        <Text>{pickers.input}</Text>
        <Text color="cyan">▏</Text>
        <Text dimColor>
          {pickers.error
            ? `  ${pickers.error}`
            : '  ↑↓ pick · enter profile · esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}
