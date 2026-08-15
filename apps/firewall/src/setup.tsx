// Entrypoint for the firewall rule manager.
//   - TTY:                 interactive Ink TUI
//   - no TTY + --apply:    non-interactive apply (CI / automation)
//   - no TTY + --dry-run:  preview what would change, no writes
//   - no TTY, neither:     refuse (a piped/redirected run must NOT silently mutate the live WAF)
//   - --mock:              the TUI on a recorded cassette, sandboxed, with no real credentials
//   - --record --cassette: a live run that also writes its responses to a named cassette
// Run from the repo root so bun loads .env.local:  bun run firewall:setup
//
// From env.ts, which imports nothing and cannot throw — so a missing-env failure in the firewall
// modules still surfaces via main().catch() as a clean message rather than an import-time stack.

import { render } from 'ink';

import {
  cassetteArg,
  isApply,
  isDryRun,
  isInteractive,
  isMock,
  isRecording,
} from './env';
import type { Boot, Choice, Session } from './mock/boot';
import type { CassetteInfo } from './mock/cassette-store';
import { errMsg } from './util';

const interactive = isInteractive();
const dryRun = isDryRun();
const apply = isApply();
const mock = isMock();
const recording = isRecording();
const cassette = cassetteArg();

/** Show the cassette list and wait for a choice. Its own Ink render, before the app exists, so nothing has drawn itself from a corpus that has not been chosen yet. */
async function pickCassette(
  available: readonly CassetteInfo[],
): Promise<Choice> {
  const { CassettePicker } = await import('./mock/cassette-picker');
  const { cassettesDir } = await import('./mock/cassette-store');
  // Quit unless something says otherwise: a picker torn down without a choice must not start a
  // session on whatever happened to be first.
  let picked: Choice = { kind: 'quit' };
  const app = render(
    <CassettePicker
      available={available}
      drawer={cassettesDir()}
      onPick={(choice) => {
        picked = choice;
      }}
    />,
  );
  await app.waitUntilExit();
  return picked;
}

async function main() {
  if (apply && dryRun) {
    console.error('--apply and --dry-run are mutually exclusive.');
    process.exitCode = 1;
    return;
  }
  if (mock && recording) {
    console.error(
      '--mock and --record are mutually exclusive: one replays the cassette, the other writes it.',
    );
    process.exitCode = 1;
    return;
  }
  if (recording && !cassette) {
    console.error(
      'A recording needs a name: bun run firewall:record --cassette <name>\n' +
        'One cassette per scenario — recordings append, so a shared one drifts toward whatever was recorded last.',
    );
    process.exitCode = 1;
    return;
  }
  // Before anything else imports: client.ts and rules.ts read the environment at import time, and
  // a mock session is only credential-free if the fabrication happens first.
  let session: Session | undefined;
  if (mock || recording) {
    const boot = await import('./mock/boot');
    // The picker is an Ink render of its own, so it needs a terminal. Without one, --cassette is
    // the only way to choose, and bootMock says so rather than silently picking.
    const result: Boot = mock
      ? await boot.bootMock({
          named: cassette,
          pick: interactive ? pickCassette : undefined,
        })
      : await boot.bootRecording(cassette as string);
    if (result.kind === 'quit') return;
    if (result.kind === 'refused') {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }
    session = result.session;
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
  // After the TUI has given the terminal back, or it is written to a buffer that is about to go.
  if (session) console.log(session.summary());
}

main().catch((error) => {
  console.error('firewall setup failed:', errMsg(error));
  process.exit(1);
});
