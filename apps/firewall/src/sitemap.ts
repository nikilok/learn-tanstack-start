// Entrypoint for `bun run firewall:sitemap` — who read the sitemaps, and what they did next.
// Read-only. Also available as the `s` pane inside `bun run firewall:setup`.

import { resolveVercelCredentials } from './credentials';
import { toAnsi } from './line-model';
import { fetchSitemapReport } from './sitemap-readers';
import { sitemapLines } from './sitemap-view';
import { rollingWindow } from './time-window';
import { errMsg } from './util';

const DEFAULT_HOURS = 144;
const MAX_HOURS = 24 * 6; // `observability_chart_free` rejects a startTime older than 7 days

const USAGE = `Usage:
  bun run firewall:sitemap [hours]    default ${DEFAULT_HOURS}h, max ${MAX_HOURS}h`;

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

  const report = await fetchSitemapReport(
    resolveVercelCredentials(),
    rollingWindow(hours, new Date()),
  );
  console.log(
    toAnsi(sitemapLines(report), {
      colour: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    }),
  );
}

if (import.meta.main)
  main().catch((error) => {
    console.error('firewall:sitemap failed:', errMsg(error));
    process.exit(1);
  });
