// Entrypoint for `bun run firewall:kin` — what else is on the build line of something we denied.
// Read-only. It stages nothing, writes nothing, and names no verdict; the operator reads and acts.

import { resolveVercelCredentials } from './credentials';
import { useColour } from './env';
import { fetchKinReport } from './kin-report';
import { kinLines } from './kin-view';
import { toAnsi } from './line-model';
import { rollingWindow } from './time-window';
import { errMsg } from './util';

const DEFAULT_HOURS = 144;
const MAX_HOURS = 24 * 6; // `observability_chart_free` rejects a startTime older than 7 days

const USAGE = `Usage:
  bun run firewall:kin [hours]    default ${DEFAULT_HOURS}h, max ${MAX_HOURS}h

Lists every fingerprint sharing a TLS build line with one on FW_BLOCKED_JA4 or
FW_CHALLENGE_JA4, with what its traffic did. Read-only.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const raw = argv.find((a) => !a.startsWith('--'));
  const hours = raw === undefined ? DEFAULT_HOURS : Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
    throw new Error(`hours must be an integer from 1 to ${MAX_HOURS}`);

  const report = await fetchKinReport(
    resolveVercelCredentials(),
    rollingWindow(hours, new Date()),
  );
  console.log(toAnsi(kinLines(report), { colour: useColour() }));
}

if (import.meta.main)
  main().catch((error) => {
    console.error('firewall:kin failed:', errMsg(error));
    process.exit(1);
  });
