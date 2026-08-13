// The y/n gate. A deny can take real users offline, so it never happens on one keystroke.

import { Box, Text } from 'ink';

export type Confirmation = {
  prompt: string;
  detail: string;
  onYes: () => void;
};

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
