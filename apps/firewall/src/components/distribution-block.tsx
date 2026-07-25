// One path's per-IP peak distribution: the block plus its own row (DistLine has one caller).

import { Box, Text } from 'ink';

import type { DistRow, Distribution } from '../report-data';
import {
  barColor,
  distHeader,
  distPeaks,
  distRowText,
  usageBar,
} from './report-format';

const MAX_ROWS = 6; // matches PEAK_IPS in report-data.ts — the IPs actually measured

/** One IP's line in a distribution: the usage bar, coloured by proximity to whichever ceiling that IP is nearest, followed by its measured figures. */
function DistLine({ row, dist }: { row: DistRow; dist: Distribution }) {
  return (
    <Box>
      <Text color={barColor(row, dist.limit, dist.sustainedLimit)}>
        {`${usageBar(row.peakMin, dist.maxPeakMin ?? 0)} `}
      </Text>
      <Text wrap="truncate">{distRowText(row)}</Text>
    </Box>
  );
}

/** A path's calibration block: its configured ceilings, the measured worst case against them, then a bar per IP. Degrades to a skip/empty note so one failed path never blanks the pane. */
export function DistributionBlock({ dist }: { dist: Distribution }) {
  const rows = dist.rows ?? [];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold wrap="truncate">
        per-IP · {dist.label}
      </Text>
      {dist.skipped ? (
        <Text dimColor wrap="truncate">
          (skipped — {dist.skipped})
        </Text>
      ) : dist.empty ? (
        <Text dimColor>(no traffic)</Text>
      ) : (
        <>
          <Text dimColor wrap="truncate">
            {distHeader(dist)}
          </Text>
          <Text dimColor wrap="truncate">
            {distPeaks(dist)}
          </Text>
          {rows.slice(0, MAX_ROWS).map((r) => (
            <DistLine key={r.ip} row={r} dist={dist} />
          ))}
          {rows.length > MAX_ROWS && (
            <Text dimColor>{`  +${rows.length - MAX_ROWS} more`}</Text>
          )}
        </>
      )}
    </Box>
  );
}
