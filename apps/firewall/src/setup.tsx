// Entrypoint for the firewall rule manager. With a TTY, renders the interactive Ink TUI;
// otherwise (CI / piped) applies non-interactively. Run from the repo root so bun loads
// .env.local:  bun run firewall:setup

import { render } from 'ink';

import { App } from './app';
import { runHeadless } from './client';

if (process.stdout.isTTY && process.stdin.isTTY) {
  render(<App />);
} else {
  runHeadless().catch((error) => {
    console.error('firewall setup failed:', error);
    process.exit(1);
  });
}
