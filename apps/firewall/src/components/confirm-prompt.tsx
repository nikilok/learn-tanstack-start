// The y/n gate. A deny can take real users offline, so it never happens on one keystroke.

import { Box, Text } from 'ink';

export type Confirmation = {
  prompt: string;
  detail: string;
  onYes: () => void;
};

// Rows greedily, the way `wrap` does: a word is never split, so counting characters would
// under-count and the frame would still overflow.
/** Lines `text` occupies once wrapped to `width`. */
function wrappedRows(text: string, width: number): number {
  if (width <= 0) return 1;
  let rows = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    if (used === 0) used = word.length;
    else if (used + 1 + word.length <= width) used += 1 + word.length;
    else {
      rows++;
      used = word.length;
    }
  }
  return rows;
}

/**
 * Rows this dialog will occupy, so the pane can reserve them.
 *
 * A flat three was assumed, and the ASN detail is a paragraph — it wrapped to five or six lines,
 * grew the frame past the viewport, and scrolled the header and the editor cursor off screen. The
 * detail is the safety warning, so it wraps rather than truncating; what has to give is the
 * reservation, not the text.
 */
export function confirmRows(c: Confirmation, width: number): number {
  return wrappedRows(c.prompt, width) + wrappedRows(c.detail, width) + 1;
}

export function ConfirmPrompt({ confirm: c }: { confirm: Confirmation }) {
  return (
    <Box flexDirection="column">
      <Text color="yellow" bold>
        {c.prompt}
      </Text>
      <Box>
        <Text dimColor>{c.detail}</Text>
      </Box>
      <Text>
        <Text color="yellow" bold>
          y
        </Text>
        <Text dimColor> yes · </Text>
        <Text bold>n</Text>
        <Text dimColor> no (esc cancels)</Text>
      </Text>
    </Box>
  );
}
