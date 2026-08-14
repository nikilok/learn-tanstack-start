// Entrypoint for the firewall rule manager.
//   - TTY:                 interactive Ink TUI
//   - no TTY + --apply:    non-interactive apply (CI / automation)
//   - no TTY + --dry-run:  preview what would change, no writes
//   - no TTY, neither:     refuse (a piped/redirected run must NOT silently mutate the live WAF)
// Run from the repo root so bun loads .env.local:  bun run firewall:setup
//
// From env.ts, which imports nothing and cannot throw — so a missing-env failure in the firewall
// modules still surfaces via main().catch() as a clean message rather than an import-time stack.

import { render } from 'ink';

import { isApply, isDryRun, isInteractive } from './env';
import { errMsg } from './util';

const interactive = isInteractive();
const dryRun = isDryRun();
const apply = isApply();

async function main() {
  if (apply && dryRun) {
    console.error('--apply and --dry-run are mutually exclusive.');
    process.exitCode = 1;
    return;
  }
  if (interactive) {
    const { App } = await import('./app');
    const { enterTuiScreen, leaveTuiScreen } = await import('./terminal');
    enterTuiScreen();
    try {
      await render(<App />).waitUntilExit();
    } finally {
      // Before anything prints: an error surfaced while still on the app buffer vanishes with it.
      leaveTuiScreen();
    }
  } else if (apply || dryRun) {
    const { runHeadless } = await import('./client');
    await runHeadless();
  } else {
    console.error(
      'firewall:setup is interactive — no TTY detected.\n' +
        'Run it in a terminal for the TUI, or pass --apply to apply non-interactively (CI), or --dry-run to preview.',
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('firewall setup failed:', errMsg(error));
  process.exit(1);
});
