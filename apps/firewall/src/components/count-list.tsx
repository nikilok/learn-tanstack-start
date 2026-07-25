// A labelled block of counted lines — the shape shared by the report's "actions by rule" and
// "top paths" sections, which differ only in title, data and empty-state wording.

import { Box, Text } from 'ink';

/** A titled list of `count  label` lines with a "+N more" tail, degrading to a skip note when its query failed or an empty note when there is nothing to show. */
export function CountList({
  title,
  rows,
  error,
  empty = '(none)',
  max = 12,
}: {
  title: string;
  rows: { label: string; count: number }[];
  error?: string;
  empty?: string;
  max?: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {error ? (
        <Text dimColor wrap="truncate">
          (skipped — {error})
        </Text>
      ) : rows.length ? (
        <>
          {rows.slice(0, max).map((x) => (
            <Text
              key={x.label}
              wrap="truncate"
            >{`${String(x.count).padStart(8)}  ${x.label}`}</Text>
          ))}
          {rows.length > max && (
            <Text dimColor>{`  +${rows.length - max} more`}</Text>
          )}
        </>
      ) : (
        <Text dimColor>{empty}</Text>
      )}
    </Box>
  );
}
