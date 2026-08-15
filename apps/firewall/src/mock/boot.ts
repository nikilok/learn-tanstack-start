// Everything a mock or recording session does before the app exists.
//
// Order is the whole design here. `client.ts` and `rules.ts` read the environment at IMPORT time,
// so the credentials have to be fabricated before either is pulled in — which is why every import
// below is dynamic and why this runs from the entrypoint rather than from a module that something
// else already imported.

// The static imports below reach only ../repo-root, so none of them reads the environment.
// Anything that does — ../rules, ../client, ../observability — MUST stay a dynamic import inside
// bootMock, after fabricateEnv.
import { appendFileSync } from 'node:fs';

import type { Miss } from './backend';
import { cassetteAgeDays, cassettePath, loadCassette } from './cassette';
import {
  fabricateEnv,
  missLogPath,
  prepareSandbox,
  readSandboxEnv,
  sandboxEnvPath,
} from './sandbox';

// Past this, traffic shapes have moved enough that the corpus describes a different site.
const STALE_CASSETTE_DAYS = 30;

export type Session = {
  /** What to print once the TUI has given the terminal back. */
  summary: () => string;
};

function note(path: string, line: string): void {
  try {
    appendFileSync(path, `${new Date().toISOString()}  ${line}\n`);
  } catch {
    // The miss log is diagnostics. Losing it must not take the session down.
  }
}

/** Boot a mock session: sandbox the state, fabricate the environment, and serve every read from the cassette. */
export async function bootMock(): Promise<Session> {
  const dir = prepareSandbox();
  // Read BEFORE the overwrite, which is the only moment it is knowable. A real token here means
  // the session was launched through firewall:setup rather than firewall:mock, so it is running on
  // one safety layer instead of two — still sandboxed, but worth saying out loud.
  const inherited = Boolean(process.env.VERCEL_TOKEN);
  fabricateEnv(readSandboxEnv(sandboxEnvPath()));
  // Every state file this tool keeps is resolved from cwd, so one chdir redirects the watch list,
  // the ignore list, the watch log and the investigated set at once. The test preload already
  // does exactly this, for exactly the same reason.
  process.chdir(dir);

  const cassette = loadCassette(cassettePath());
  const ageDays = cassetteAgeDays(cassettePath());
  const log = missLogPath();
  const misses = new Map<string, number>();
  const onMiss = (miss: Miss) => {
    misses.set(miss.reason, (misses.get(miss.reason) ?? 0) + 1);
    note(log, `${miss.reason}  ${miss.key}`);
  };

  const { mockObservability, mockWaf, recordedLiveConfig } =
    await import('./backend');
  const { decodeLiveConfig } = await import('./codec');
  const observability = await import('../observability');
  observability.installObservabilityBackend(
    mockObservability(cassette, onMiss),
  );
  const client = await import('../client');
  client.installWafBackend(
    mockWaf(decodeLiveConfig(recordedLiveConfig(cassette))),
  );

  note(
    log,
    `session  ${cassette.entries.size} recordings, ${cassette.skipped} unreadable lines${
      inherited ? ', launched with a real credential in the environment' : ''
    }`,
  );
  return {
    summary: () => {
      const unrecorded = misses.get('unrecorded') ?? 0;
      const substituted = misses.get('window-substituted') ?? 0;
      const parts = [
        `mock session over ${cassette.entries.size} recordings`,
        ageDays !== undefined && ageDays >= STALE_CASSETTE_DAYS
          ? `the cassette is ${ageDays} days old — re-record it, or delete it (it holds real client IPs and fingerprints)`
          : '',
        unrecorded ? `${unrecorded} queries had nothing recorded` : '',
        substituted ? `${substituted} answered from another window` : '',
        unrecorded || substituted ? `see ${log}` : '',
        inherited
          ? 'note: a real VERCEL_TOKEN was in the environment and was overwritten — run `bun run firewall:mock` to keep it out of the process entirely'
          : '',
      ].filter(Boolean);
      return parts.join(' · ');
    },
  };
}

/** Boot a recording session: a fully live run that also writes every response to the cassette. */
export async function bootRecording(): Promise<Session> {
  const path = cassettePath();
  const { recordingObservability, recordingWaf } = await import('./record');
  const observability = await import('../observability');
  observability.installObservabilityBackend(
    recordingObservability(observability.liveObservability, path),
  );
  const client = await import('../client');
  client.installWafBackend(recordingWaf(client.liveWaf, path));
  return { summary: () => `recording appended to ${path}` };
}
