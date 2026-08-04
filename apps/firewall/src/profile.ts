// Entrypoint for `bun run firewall:ip` — profile one client IP, or list the busiest.
// Read-only: it queries observability and prints. It never writes firewall config.
//
//   bun run firewall:ip 1.2.3.4          profile that IP over the last 24h
//   bun run firewall:ip 1.2.3.4 72       ... over the last 72h
//   bun run firewall:ip --top            busiest IPs in the last 24h
//   bun run firewall:ip --top 6 --limit 40

import { adviseBan } from './ban-advice';
import { resolveVercelCredentials } from './credentials';
import { JA4_DENY, envMatching } from './deny-list';
import { fetchIpProfile, topIps } from './ip-profile';
import { profileLines } from './ip-profile-view';
import { toAnsi } from './line-model';
import { errMsg } from './util';

const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 6; // `observability_chart_free` rejects a startTime older than 7 days
const DEFAULT_TOP = 30;

const USAGE = `Usage:
  bun run firewall:ip <ip> [hours]        profile one IP (default ${DEFAULT_HOURS}h, max ${MAX_HOURS}h)
  bun run firewall:ip --top [hours] [--limit N]   busiest IPs in the window`;

/** Parse a positional hours argument, clamped to what the free observability window allows. */
export function hoursFrom(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HOURS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`hours must be a positive integer, got "${raw}"`);
  if (n > MAX_HOURS)
    throw new Error(
      `hours must be <= ${MAX_HOURS} (the free observability window)`,
    );
  return n;
}

export type Args =
  | { mode: 'help' }
  | { mode: 'top'; hours: number; limit: number }
  | { mode: 'profile'; ip: string; hours: number };

/** Parse argv. `--limit N` consumes its value, so it never reads back as the hours positional. */
export function parseArgs(argv: string[]): Args {
  if (!argv.length || argv.includes('--help') || argv.includes('-h'))
    return { mode: 'help' };

  const flagAt = argv.indexOf('--limit');
  const valueAt = flagAt === -1 ? -1 : flagAt + 1; // -1, not 0 — index 0 is the IP
  const positional = argv.filter(
    (a, i) => !a.startsWith('--') && i !== valueAt,
  );

  if (argv.includes('--top')) {
    const limit = flagAt === -1 ? DEFAULT_TOP : Number(argv[valueAt]);
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('--limit must be a positive integer');
    return { mode: 'top', hours: hoursFrom(positional[0]), limit };
  }
  const [ip, rawHours] = positional;
  if (!ip) return { mode: 'help' };
  return { mode: 'profile', ip, hours: hoursFrom(rawHours) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log(USAGE);
    return;
  }
  const creds = resolveVercelCredentials();

  if (args.mode === 'top') {
    const { rows, error } = await topIps(creds, args.hours, args.limit);
    if (error) throw new Error(error);
    console.log(`Busiest IPs, last ${args.hours}h\n`);
    for (const [ip, count] of rows)
      console.log(`  ${String(count).padStart(8)}  ${ip}`);
    console.log(`\nProfile one with: bun run firewall:ip <ip> ${args.hours}`);
    return;
  }

  const profile = await fetchIpProfile(creds, args.ip, args.hours);
  // Not required: without a denylist configured nothing is already-denied, which is the truth.
  const deniedJa4 = envMatching('FW_BLOCKED_JA4', JA4_DENY, false);
  const advice = adviseBan({
    total: profile.total,
    mix: profile.mix,
    shape: profile.shape,
    ja4: profile.byJa4,
    asns: profile.byAsn,
    botVerified: profile.byBotVerified,
    wafActions: profile.byWafAction,
    wafRules: profile.byWafRule,
    digestReach: profile.digestReach,
    asnReach: profile.asnReach,
    alreadyDeniedJa4: deniedJa4.includes(profile.byJa4[0]?.[0] ?? ''),
    // The CLI cannot map an AS name to its number, so it never claims one is already denied.
    alreadyDeniedAsn: false,
    windowMinutes: profile.windowHours * 60,
  });
  console.log(
    toAnsi(profileLines(profile, process.stdout.columns, advice), {
      colour: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    }),
  );
}

// Guarded so the arg parser above can be imported by tests without running a query.
if (import.meta.main)
  main().catch((error) => {
    console.error('firewall:ip failed:', errMsg(error));
    process.exit(1);
  });
