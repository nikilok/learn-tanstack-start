// Entrypoint for the firewall rule manager.
//   - TTY:                 interactive Ink TUI
//   - no TTY + --apply:    non-interactive apply (CI / automation)
//   - no TTY + --dry-run:  preview what would change, no writes
//   - no TTY, neither:     refuse (a piped/redirected run must NOT silently mutate the live WAF)
// Run from the repo root so bun loads .env.local:  bun run firewall:setup
//
// `dryRun`/`apply` are read from argv directly (not imported) so a missing-env throw in the
// firewall modules surfaces via main().catch() as a clean message rather than a raw import-time stack.

import { render } from 'ink';

import { errMsg } from './util';

const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const dryRun =
  process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const apply = process.argv.includes('--apply');

async function main() {
  if (apply && dryRun) {
    console.error('--apply and --dry-run are mutually exclusive.');
    process.exitCode = 1;
    return;
  }
  if (interactive) {
    const { App } = await import('./app');
    render(<App />);
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
