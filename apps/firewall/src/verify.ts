// Entrypoint for `bun run firewall:verify` — check the tool's assumptions against live data.
// READ-ONLY. It queries, compares and prints; it changes nothing.
//
// Review catches code that does not do what it says. It cannot catch code that says the wrong
// thing, and twice now that has been the expensive kind: a filter the API accepts and silently
// matches nothing, and a filter naming one action out of three that reach the app. Both read
// correctly. Both were found by asking production the same question two ways and noticing the
// answers disagreed.
//
// So each check here derives one number the way the tool does, derives it again by an independent
// route, and reports whether they agree. A disagreement does not care who wrote the code.

import { resolveVercelCredentials } from './credentials';
import { JA4_DENY, envMatching } from './deny-list';
import { alpnOf } from './ip-signals';
import { type Ctx, type Row, countOf, makeCtx, metrics } from './observability';
import { rollingWindow } from './time-window';
import { errMsg } from './util';
import {
  impersonators,
  mergeScreens,
  nonRendering,
  verifiedDigests,
} from './watch';

const USAGE = `Usage:
  bun run firewall:verify [hours]    default 144 (the full observability window)

Read-only. Exits 1 if any assumption disagrees with live data.`;

const PASSED_FILTER = "wafAction ne 'deny' and wafAction ne 'challenge'";
const IMPERSONATION = 'browser_impersonation';
const GROUP_CAP = 500;

type Check = {
  name: string;
  /**
   * `null` is INCONCLUSIVE — the check could not be decided. Distinct from `true`, because a
   * check that never ran is not a check that passed, and rendering it as a tick is how a tool
   * built to catch silent failure acquires one.
   */
  ok: boolean | null;
  detail: string;
};

/**
 * Whether more than one action reaches the app, or `null` when nothing did.
 *
 * A quiet or deny-only window carries no evidence either way: `agrees(0, 0)` is true, so the
 * binary form reported the assumption as DISAGREEING — a check that could not run, failing, and
 * exiting non-zero on an idle night. Same shape as `denylistCheck` below, and the twin of it that
 * was missed when that one was given its third state.
 */
export function narrowingCheck(
  passed: number,
  allowOnly: number,
): boolean | null {
  if (passed === 0) return null;
  return !agrees(passed, allowOnly);
}

/**
 * The labelled-positive check, or `null` when it cannot be decided.
 *
 * Only fingerprints still getting through are evidence about the SCREEN; the rest are evidence
 * about the ban. So an empty denylist, a window entirely after the ban, or a truncated response
 * that could hide a still-arriving digest all leave the question open — and `every` over an empty
 * list is vacuously true, which is exactly how that reads as a pass.
 */
export function denylistCheck(input: {
  denylistRead: boolean;
  denied: number;
  stillArriving: readonly string[];
  surfaced: ReadonlySet<string>;
  capped: boolean;
}): boolean | null {
  if (!input.denylistRead) return false;
  if (input.capped || input.denied === 0 || input.stillArriving.length === 0)
    return null;
  return input.stillArriving.every((d) => input.surfaced.has(d));
}

const sum = (rows: Row[]) => rows.reduce((n, r) => n + countOf(r), 0);
const rowsOf = (r: { summary?: Row[] }) => r.summary ?? [];

/** Agreement within a small margin: the two queries are separate calls and traffic moves between them. */
function agrees(a: number, b: number, tolerance = 0.005): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale <= tolerance;
}

/**
 * Every action seen, and which of them reached the app. The screen's filter is expressed as a
 * negation, so the thing to verify is that the negation and the enumeration describe one set.
 */
async function actionPartition(ctx: Ctx): Promise<Check[]> {
  const all = rowsOf(await metrics(ctx, ['wafAction'], { limit: GROUP_CAP }));
  const passed = rowsOf(
    await metrics(ctx, ['wafAction'], {
      filter: PASSED_FILTER,
      limit: GROUP_CAP,
    }),
  );
  const byAction = new Map(
    all.map((r) => [String(r.wafAction ?? ''), countOf(r)]),
  );
  const stopped =
    (byAction.get('deny') ?? 0) + (byAction.get('challenge') ?? 0);
  const expected = sum(all) - stopped;

  const names = [...byAction.keys()].sort().join(', ');
  return [
    {
      name: 'the passed-filter matches every action except deny and challenge',
      ok: agrees(sum(passed), expected),
      detail: `filter=${sum(passed)} enumerated=${expected} · actions seen: ${names || '(none)'}`,
    },
    {
      // The screen used to name `allow` alone. If a future edit narrows it again, this says by
      // how much — an action that reaches the app and is not named is invisible traffic.
      name: 'no single action accounts for everything that reached the app',
      ok: narrowingCheck(sum(passed), byAction.get('allow') ?? 0),
      detail:
        sum(passed) === 0
          ? 'nothing reached the app in this window — not decidable'
          : `passed=${sum(passed)} allow-only=${byAction.get('allow') ?? 0} — naming one action would miss ${sum(passed) - (byAction.get('allow') ?? 0)}`,
    },
  ];
}

/**
 * The category is selected in code because it cannot be filtered. That makes the selection a
 * place where a silent mismatch can hide, so it is derived twice.
 */
async function categorySelection(ctx: Ctx): Promise<Check[]> {
  const byCategory = rowsOf(
    await metrics(ctx, ['botCategory'], {
      filter: PASSED_FILTER,
      limit: GROUP_CAP,
    }),
  );
  const viaCategory = byCategory
    .filter((r) => String(r.botCategory ?? '') === IMPERSONATION)
    .reduce((n, r) => n + countOf(r), 0);

  const twoDim = rowsOf(
    await metrics(ctx, ['clientJa4Digest', 'botCategory'], {
      filter: PASSED_FILTER,
      limit: GROUP_CAP,
    }),
  );
  const viaScreen = impersonators(twoDim).reduce((n, s) => n + s.allowed, 0);

  return [
    {
      name: 'the screen sees every impersonation request the category count reports',
      ok: agrees(viaScreen, viaCategory, 0.02),
      detail: `screen=${viaScreen} category-groupby=${viaCategory}`,
    },
    {
      // Because the category cannot be filtered, unrelated groups compete for the same slots.
      name: 'the two-dimension response is not at the group cap',
      ok: twoDim.length < GROUP_CAP,
      detail: `${twoDim.length}/${GROUP_CAP} groups — at the cap, impersonation rows can be dropped and the window reads quiet`,
    },
    {
      // A category the tool ignores entirely. Worth seeing rather than assuming it is small.
      name: 'unclassified traffic is visible, not silently excluded',
      ok: true,
      detail: (() => {
        const blank = byCategory
          .filter((r) => !String(r.botCategory ?? ''))
          .reduce((n, r) => n + countOf(r), 0);
        const total = sum(byCategory);
        return `${blank} of ${total} passed requests carry no category (${total ? ((blank / total) * 100).toFixed(1) : 0}%) — the screen does not look at these`;
      })(),
    },
  ];
}

/**
 * The known-bad period is the only labelled positive available. If the tool cannot surface the
 * fingerprints that took the site during it, nothing else it reports means much.
 */
async function knownBadPeriod(ctx: Ctx): Promise<Check[]> {
  const twoDim = rowsOf(
    await metrics(ctx, ['clientJa4Digest', 'botCategory'], {
      filter: PASSED_FILTER,
      limit: GROUP_CAP,
    }),
  );
  // Both screens, as the tool itself runs them. Checking only the category screen would count a
  // fingerprint the behavioural screen surfaces as one the tool missed.
  const routeRows = rowsOf(
    await metrics(ctx, ['clientJa4Digest', 'route'], {
      filter: PASSED_FILTER,
      limit: GROUP_CAP,
    }),
  );
  const verifiedRows = rowsOf(
    await metrics(ctx, ['clientJa4Digest', 'botVerified'], {
      filter: PASSED_FILTER,
      limit: GROUP_CAP,
    }),
  );
  const seen = mergeScreens(
    impersonators(twoDim),
    nonRendering(routeRows, verifiedDigests(verifiedRows)),
  );
  const noAlpn = seen.filter((s) => alpnOf(s.digest) === '00');
  const busiest = seen[0];

  // The denylist is the operator's own labelling: a digest in it is one a human decided was a
  // scraper. That makes it the closest thing to ground truth this system has.
  let denied: string[] = [];
  let denylistRead = true;
  try {
    // Both tiers. A challenged digest still arriving is the effectiveness check that watch mode
    // deliberately does not make — it drops them from candidacy on the assumption this runs.
    denied = [
      ...envMatching('FW_BLOCKED_JA4', JA4_DENY, false),
      ...envMatching('FW_CHALLENGE_JA4', JA4_DENY, false),
    ];
  } catch {
    denylistRead = false;
  }
  const known = new Set(denied.map((d) => JA4_DENY.normalize(d)));
  const surfaced = new Set(seen.map((s) => JA4_DENY.normalize(s.digest)));
  const surfacedAndKnown = seen.filter((s) =>
    known.has(JA4_DENY.normalize(s.digest)),
  );

  // A working ban erases its own evidence: once a digest is denied its traffic never reaches the
  // app, so a screen that only looks at what got through cannot see it — and must not be marked
  // as having missed it. Split the denied into those still arriving and those fully stopped.
  const byAction = rowsOf(
    await metrics(ctx, ['clientJa4Digest', 'wafAction'], { limit: GROUP_CAP }),
  );
  const passedByDigest = new Map<string, number>();
  for (const r of byAction) {
    const action = String(r.wafAction ?? '');
    if (action === 'deny' || action === 'challenge') continue;
    const d = JA4_DENY.normalize(String(r.clientJa4Digest ?? ''));
    passedByDigest.set(d, (passedByDigest.get(d) ?? 0) + countOf(r));
  }
  // At the cap the response may omit a denied digest entirely, which would read as stopped.
  const byActionCapped = byAction.length >= GROUP_CAP;
  const stillArriving = [...known].filter(
    (d) => (passedByDigest.get(d) ?? 0) > 0,
  );
  const fullyStopped = known.size - stillArriving.length;

  return [
    {
      name: 'the screen surfaces fingerprints at all in this window',
      ok: seen.length > 0,
      detail: seen.length
        ? `${seen.length} impersonation fingerprint(s), busiest ${busiest?.allowed} requests`
        : 'NONE — a window known to contain scraping should not be empty',
    },
    {
      // The one end-to-end check available: would the screen have found what a human found?
      // If a digest you banned by hand does not appear here, the screen cannot see its kind.
      name: 'every banned fingerprint still reaching the app is one the screen can see',
      // Only the ones still getting through are evidence about the screen. The rest are evidence
      // about the ban, and a window entirely after the ban proves nothing either way — which is
      // inconclusive, not a pass and not a failure.
      // Membership, not a count. Comparing cardinalities happens to work only while one set is a
      // subset of the other, which nothing here states or enforces — and the day that stops being
      // true, the check passes while the screen is missing something a human banned.
      ok: denylistCheck({
        denylistRead,
        denied: denied.length,
        stillArriving,
        surfaced,
        capped: byActionCapped,
      }),
      detail: !denylistRead
        ? 'FW_BLOCKED_JA4 could not be read — cannot check against your own labelling'
        : byActionCapped
          ? `the action breakdown hit the ${GROUP_CAP}-group cap — a denied fingerprint could be missing from it and read as fully stopped, so this cannot be decided`
          : denied.length === 0
            ? 'nothing is denied, so there is no labelled positive to check against'
            : stillArriving.length === 0
              ? `all ${denied.length} denied fingerprint(s) are fully stopped in this window — the ban is working, so the screen cannot see them. Widen the window past the ban to test the screen.`
              : (() => {
                  const missed = stillArriving.filter((d) => !surfaced.has(d));
                  return (
                    `${stillArriving.length - missed.length} of ${stillArriving.length} still-arriving denied fingerprint(s) appear in the screen` +
                    (fullyStopped ? ` (${fullyStopped} fully stopped)` : '') +
                    (missed.length
                      ? ` — ${missed.length} the screen would NOT have found`
                      : ` — busiest ${surfacedAndKnown[0]?.allowed} requests`)
                  );
                })(),
    },
    {
      name: 'at least one surfaced fingerprint carries a volume-independent tell',
      ok: noAlpn.length > 0,
      detail: `${noAlpn.length} of ${seen.length} offered no ALPN`,
    },
  ];
}

/**
 * The one line an operator actually reads.
 *
 * Inconclusive is counted separately rather than folded into the pass, for the reason `Check.ok`
 * gives: a check that never ran is not a check that passed. Saying "all N agree" while some of
 * them were undecidable is the silent failure this tool exists to report.
 */
export function summaryLine(checks: readonly { ok: boolean | null }[]): string {
  const failed = checks.filter((c) => c.ok === false).length;
  const unknown = checks.filter((c) => c.ok === null).length;
  if (failed)
    return `${failed} of ${checks.length} assumptions disagree with live data`;
  if (unknown)
    return `${checks.length - unknown} of ${checks.length} assumptions agree with live data, ${unknown} could not be checked`;
  return `all ${checks.length} assumptions agree with live data`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const hours = Number(argv.find((a) => !a.startsWith('--')) ?? 144);
  if (!Number.isInteger(hours) || hours < 1 || hours > 144)
    throw new Error('hours must be an integer from 1 to 144');

  const creds = resolveVercelCredentials();
  const window = rollingWindow(hours, new Date());
  const { ctx } = makeCtx(creds, window);
  console.log(
    `Verify — ${window.label}  (${window.fromISO.slice(0, 16)}Z → ${window.toISO.slice(0, 16)}Z)\n`,
  );

  const checks: Check[] = [];
  for (const [group, run] of [
    ['waf actions', actionPartition],
    ['category selection', categorySelection],
    ['known-bad period', knownBadPeriod],
  ] as const) {
    console.log(`${group}`);
    try {
      const got = await run(ctx);
      checks.push(...got);
      for (const c of got)
        console.log(
          `  ${c.ok === null ? '?' : c.ok ? '✔' : '✖'} ${c.name}\n      ${c.detail}`,
        );
    } catch (e) {
      // A check that could not run is a failure, not a pass. The whole point is that unknown
      // does not get to look like agreement.
      const c = {
        name: `${group} could not be checked`,
        ok: false,
        detail: errMsg(e),
      };
      checks.push(c);
      console.log(`  ✖ ${c.name}\n      ${c.detail}`);
    }
    console.log('');
  }

  // Inconclusive does not fail the run — a working ban makes one check inconclusive by design,
  // and crying wolf every time is how a tool gets ignored. It just never renders as a pass.
  console.log(summaryLine(checks));
  process.exitCode = checks.some((c) => c.ok === false) ? 1 : 0;
}

if (import.meta.main)
  main().catch((error) => {
    console.error('firewall:verify failed:', errMsg(error));
    process.exit(1);
  });
