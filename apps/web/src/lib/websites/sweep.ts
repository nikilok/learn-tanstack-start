/**
 * Revalidation sweep orchestrator. Pure but for the dependencies injected into
 * it, mirroring lib/phase5/sweep.ts, so the control flow is testable without a
 * network or a database.
 *
 * One bounded slice per run, ordered by `checked_at ASC NULLS FIRST`: a row
 * never checked sorts first, and every processed row is stamped, so the cursor
 * rotates through the table without needing to remember where it got to.
 */

import { hostNamer } from './company-naming.ts';
import type { WebsiteEvidence, WebsiteStatus } from './decide.ts';
import { evidenceRank } from './decide.ts';
import {
  needsRender,
  pageKey,
  readHomepage,
  readWalkPage,
  walkTargets,
} from './disclosure-walk.ts';
import { visibleText } from './extract.ts';
import { DISCLOSURE_PATHS, RENDER_VISIT_MS } from './fetch-policy.ts';
import {
  judgeSite,
  type NameAndPlaceRow,
  type PageRead,
} from './name-and-place.ts';
import type { Officer, OfficerLookup } from './officer-names.ts';
import {
  isAggregatorHost,
  looksChallenged,
  looksParked,
  looksPlaceholder,
  pageTooThin,
} from './page-signals.ts';
import type {
  NameAndPlaceCheck,
  RevalidateFailure,
  RevalidateResult,
} from './revalidate.ts';
import { revalidate } from './revalidate.ts';

/** Hostname of a URL, or '' when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

export type SweepRow = {
  companyNumber: string;
  url: string;
  status: WebsiteStatus;
  evidence: WebsiteEvidence;
  failureCount: number;
  /** Registered office postcode, for the weaker corroboration when the number
   *  is absent. Null when we hold no address for the company. */
  postcode: string | null;
  /** Whether this row has been through a sweep before. Disclosure probing runs
   *  on the first pass only — see findDisclosure. */
  everChecked: boolean;
  /** Stored proof page and confidence, carried so the writer can reconcile
   *  against them and lock on them rather than reasoning in SQL. */
  evidenceUrl: string | null;
  confidence: string | null;
  /** Companies House name; with the register's names, towns and the
   *  registered locality, what a `name_and_place` re-check reads. */
  companyName: string;
  sponsorNames: string[];
  registerTowns: string[];
  locality: string | null;
};

export type FetchedPage =
  | { ok: true; url: string; html: string; attemptedUrl: string }
  | {
      ok: false;
      reason: RevalidateFailure;
      attemptedUrl: string;
      /** HTTP status when the host answered — 403 means live-but-refused, 404
       *  means the page is genuinely gone. */
      status?: number;
    };

export type SweepDeps = {
  selectRows(maxRows: number): Promise<SweepRow[]>;
  /** Fetch a site, trying host and scheme variants. */
  fetchSite(url: string): Promise<FetchedPage>;
  /** Fetch one exact URL, no variants — used for disclosure paths. */
  fetchPage(url: string): Promise<FetchedPage>;
  hasCompanyNumber(html: string, companyNumber: string): boolean;
  hasPostcode(html: string, postcode: string): boolean;
  /** The company's officers, resigned ones included, or why they could not be read. Absent, the officer arm is never re-read. */
  officers?(companyNumber: string): Promise<OfficerLookup>;
  /** Read one exact URL in a browser. Absent, a `name_and_place` homepage that shows a plain fetch nothing is not read. */
  renderPage?(url: string): Promise<FetchedPage>;
  applyResult(row: SweepRow, result: RevalidateResult): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
};

export type SweepConfig = {
  maxRows: number;
  delayMs: number;
  /** How many legal/contact pages to try when the homepage carries no number.
   *  Bounded because this multiplies the request count for every row, and the
   *  disclosure is on the homepage or one click from it or effectively absent. */
  maxDisclosurePaths: number;
  dryRun: boolean;
  /** Print `company_number -> url -> verdict` for each row.
   *
   *  OFF unless a human explicitly passes --verbose. That per-row line IS the
   *  enriched dataset this crawl exists to produce, this repo is public, and
   *  Actions logs are world-readable — so printing it in CI hands the whole
   *  table over for free.
   *
   *  Deliberately an explicit opt-in rather than something inferred from
   *  `process.env.CI`: an env-sniffing guard fails OPEN if the variable is ever
   *  missing, which is the wrong direction for a control protecting data. */
  logRows: boolean;
};

/** Rows between progress heartbeats. Aggregate counts only — never an
 *  identifier — so a public log shows liveness without leaking data. */
const HEARTBEAT_ROWS = 50;

export type SweepSummary = {
  selected: number;
  live: number;
  dead: number;
  promoted: number;
  adoptedVariant: number;
  robotsBlocked: number;
  disclosureFetches: number;
  /** Rows whose page carried the company's registered office postcode, which
   *  is what confirms a registry row. Named `corroborated` because that is the
   *  column name in the workflow summary and changing it would break the
   *  `extract` greps in sweep-websites.yaml. */
  corroborated: number;
  /** Rows whose evidence tier went DOWN this pass. Counted separately from
   *  `promoted`, which used to be safe as an any-change counter only because
   *  revalidate could never lower a tier. A mass withdrawal reported as a
   *  large "promoted" figure is a silent unpublish wearing the job's
   *  healthiest-looking metric. */
  demoted: number;
  /** Rows held back from rendering: parked, for sale, a directory, or an `assessed` row on a holding page or another host. */
  noSiteThere: number;
  /** `name_and_place` rows whose name or place was gone from every page read, and those not read well enough to tell. */
  nameAndPlaceGone: number;
  nameAndPlaceUnread: number;
  /** `name_and_place` homepages read again in a browser. */
  nameAndPlaceRendered: number;
  updated: number;
  lockMissed: number;
  errored: number;
  /** Set when the run stopped early because nothing was reachable. */
  systemicAbort: boolean;
};

/**
 * Consecutive unreachable rows, with no success at all, before the run stops.
 *
 * A runner with broken DNS or blocked egress fails every fetch, and each failed
 * row is committed as it goes — so a check at the END of the run diagnoses the
 * problem correctly while the demotions are already written, taking the links
 * off up to 900 company pages and sorting those rows to the back of the cursor
 * so they are the last to be revisited. 900 companies do not go offline on the
 * same night; this many in a row is our network, not theirs.
 */
export const SYSTEMIC_FAILURE_STREAK = 15;

/**
 * Look for the company's own number on the site: the homepage first, then a
 * bounded number of the pages a disclosure conventionally lives on.
 *
 * Probing is a FIRST-PASS activity only, for two reasons. A row already at
 * `crn_on_page` has the proof and only needs liveness thereafter. And a row
 * whose legal pages did not carry the number last time will almost certainly
 * not carry it next time either — without this gate, measured at ~1.6 extra
 * fetches per row, every subsequent pass would keep paying that cost forever
 * to re-learn the same negative.
 *
 * The cost is that a disclosure added to a site later goes unnoticed. That is
 * an acceptable trade: it would only move a row from `registry` to
 * `crn_on_page`, and both already render.
 */
async function findDisclosure(
  row: SweepRow,
  homepage: { url: string; html: string },
  config: SweepConfig,
  deps: SweepDeps,
  summary: SweepSummary,
): Promise<{ crnFoundAt: string | null; postcodeFoundAt: string | null }> {
  if (deps.hasCompanyNumber(homepage.html, row.companyNumber)) {
    return { crnFoundAt: homepage.url, postcodeFoundAt: null };
  }

  let postcodeFoundAt: string | null =
    row.postcode && deps.hasPostcode(homepage.html, row.postcode)
      ? homepage.url
      : null;

  if (!row.everChecked && row.evidence !== 'crn_on_page') {
    // Probe relative to the stored URL's own directory, not the bare origin.
    // normaliseWebsiteUrl keeps a path precisely because it identifies the
    // business — 665 rows look like `caremark.co.uk/arun`, one franchise of
    // many — so probing the origin spends the whole disclosure budget on the
    // franchisor's pages, which carry the franchisor's registration details.
    // Probe relative to the URL that ANSWERED, keeping the stored path. Using
    // row.url outright sent every probe for a variant-adopted row back to the
    // host that had just failed — guaranteed misses, and because probing is
    // first-pass-only those rows could never be promoted again. Using the
    // answering URL outright would instead drop the franchise path that 665
    // rows depend on, so it is the answering ORIGIN plus the stored directory.
    const answered = new URL(homepage.url);
    const dir = new URL(row.url).pathname.replace(/\/+$/, '');
    const base = answered;
    for (const path of DISCLOSURE_PATHS.slice(0, config.maxDisclosurePaths)) {
      await deps.sleep(config.delayMs);
      summary.disclosureFetches++;
      const page = await deps.fetchPage(`${base.origin}${dir}${path}`);
      if (!page.ok) continue;
      if (deps.hasCompanyNumber(page.html, row.companyNumber)) {
        return { crnFoundAt: page.url, postcodeFoundAt };
      }
      if (
        !postcodeFoundAt &&
        row.postcode &&
        deps.hasPostcode(page.html, row.postcode)
      ) {
        postcodeFoundAt = page.url;
      }
    }
  }

  return { crnFoundAt: null, postcodeFoundAt };
}

/** Hosts a re-check treats as directories beyond the listed ones: none, as the sweep's own checks do. */
const NO_CROWDED: ReadonlySet<string> = new Set();

/** A failed fetch that says a page is not there to read, rather than that it would not answer. */
function notThere(
  page: Extract<FetchedPage, { ok: false }>,
  proofPage: boolean,
): boolean {
  if (page.reason === 'http_error') {
    return page.status === 404 || page.status === 410;
  }
  // A file, or a path robots.txt closes, was never read for the proof: unless it was the proof page.
  return (
    !proofPage &&
    (page.reason === 'not_html' || page.reason === 'blocked_by_robots')
  );
}

/**
 * Re-read a `name_and_place` row's proof: the homepage, its proof page, then
 * the walk's pages until the rule holds again. A homepage that shows a plain
 * fetch nothing is read in a browser, as discovery read it, and so is the
 * walk. Officers are asked for only once the proof page has been tried.
 * `gone` only when every page it tried was read or is not there; resigned
 * officers count, as turnover is not the site changing.
 */
async function recheckNameAndPlace(
  row: SweepRow,
  homepage: { url: string; servedUrl: string; html: string },
  config: SweepConfig,
  deps: SweepDeps,
  summary: SweepSummary,
): Promise<{ check: NameAndPlaceCheck; proofAt: string | null }> {
  const company: NameAndPlaceRow = {
    companyNumber: row.companyNumber,
    companyName: row.companyName,
    sponsorNames: row.sponsorNames,
    postcode: row.postcode,
    registerTowns: row.registerTowns,
    locality: row.locality,
  };
  let home = readHomepage(
    company,
    homepage.url,
    homepage.servedUrl,
    homepage.html,
    NO_CROWDED,
  );
  let homeText = visibleText(homepage.html);
  let fetchPage = deps.fetchPage;
  let deadline: number | null = null;
  const tried = new Set([pageKey(homepage.url), pageKey(homepage.servedUrl)]);
  if (deps.renderPage && needsRender(home)) {
    summary.nameAndPlaceRendered++;
    const started = Date.now();
    const shown = await deps.renderPage(homepage.url);
    if (shown.ok) {
      const seen = readHomepage(
        company,
        homepage.url,
        shown.url,
        shown.html,
        NO_CROWDED,
      );
      // A render that landed on a directory or a holding page reads nothing.
      if (!seen.onAggregator && !seen.parked) {
        home = seen;
        homeText = visibleText(shown.html);
        fetchPage = deps.renderPage;
        tried.add(pageKey(shown.url));
        deadline = started + RENDER_VISIT_MS;
      }
    }
  }
  const pages: PageRead[] = [...(home.pages ?? [])];
  const site = { url: row.url, pages };
  // A cookie wall, a script shell, a menu its scripts build or a bot challenge shows nothing either way.
  let unread =
    pageTooThin(homeText) || looksChallenged(homeText) || home.siteLinks === 0;
  const proofPage = row.evidenceUrl;
  let mayAsk = !proofPage || tried.has(pageKey(proofPage));
  let officers: Officer[] | null | undefined;
  const judge = async () => {
    let verdict = judgeSite(company, site, officers ?? undefined);
    if (verdict.kind === 'needs_officers' && officers === undefined && mayAsk) {
      const answer = await deps.officers?.(row.companyNumber);
      officers = Array.isArray(answer) ? answer : null;
      verdict = judgeSite(company, site, officers ?? undefined);
    }
    return verdict;
  };
  let verdict = await judge();
  if (verdict.kind === 'proved') {
    return { check: 'holds', proofAt: verdict.evidenceUrl };
  }

  const base = `${new URL(homepage.url).origin}${new URL(row.url).pathname.replace(/\/+$/, '')}`;
  const targets = [
    ...(proofPage ? [proofPage] : []),
    ...walkTargets(
      base,
      home.legalLinks ?? [],
      DISCLOSURE_PATHS.length,
      home.aboutLinks ?? [],
    ),
  ];
  for (const target of targets) {
    if (tried.has(pageKey(target))) continue;
    // A site too slow for its visit in the browser is unread, never gone.
    if (deadline !== null && Date.now() >= deadline) {
      unread = true;
      break;
    }
    tried.add(pageKey(target));
    await deps.sleep(config.delayMs);
    summary.disclosureFetches++;
    const page = await fetchPage(target);
    if (target === proofPage) mayAsk = true;
    if (!page.ok) {
      if (!notThere(page, target === proofPage)) unread = true;
      continue;
    }
    const text = visibleText(page.html);
    if (looksChallenged(text) || (target === proofPage && pageTooThin(text))) {
      unread = true;
    }
    const read = readWalkPage(company, page.url, page.html, NO_CROWDED);
    if (!read) continue;
    pages.push(read.read);
    verdict = await judge();
    if (verdict.kind === 'proved') {
      return { check: 'holds', proofAt: verdict.evidenceUrl };
    }
  }
  // Every page read: the officers decide it now if anything does.
  mayAsk = true;
  verdict = await judge();
  if (verdict.kind === 'proved') {
    return { check: 'holds', proofAt: verdict.evidenceUrl };
  }
  // Still asking for officers: they could not be read, so neither could the proof.
  if (verdict.kind === 'needs_officers') unread = true;
  return { check: unread ? 'unknown' : 'gone', proofAt: null };
}

/**
 * Remove a row's identifiers from free text.
 *
 * Errors quote what failed, so a message can carry the address even when the
 * caller never interpolated it. The host is stripped separately from the full
 * URL because DNS errors name only the host.
 */
function redactRowIdentity(text: string, row: SweepRow): string {
  let out = text.split(row.companyNumber).join('<company>');
  out = out.split(row.url).join('<url>');
  try {
    out = out.split(new URL(row.url).hostname).join('<host>');
  } catch {
    // Unparseable stored URL; the whole-string replace above already covered it.
  }
  return out;
}

/** Run one bounded slice of the revalidation sweep. */
export async function sweepWebsites(
  config: SweepConfig,
  deps: SweepDeps,
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    selected: 0,
    live: 0,
    dead: 0,
    promoted: 0,
    adoptedVariant: 0,
    robotsBlocked: 0,
    disclosureFetches: 0,
    corroborated: 0,
    demoted: 0,
    noSiteThere: 0,
    nameAndPlaceGone: 0,
    nameAndPlaceUnread: 0,
    nameAndPlaceRendered: 0,
    updated: 0,
    lockMissed: 0,
    errored: 0,
    systemicAbort: false,
  };
  let failureStreak = 0;

  const rows = await deps.selectRows(config.maxRows);
  summary.selected = rows.length;

  for (const [index, row] of rows.entries()) {
    if (index > 0) await deps.sleep(config.delayMs);
    try {
      const fetched = await deps.fetchSite(row.url);

      let crnFoundAt: string | null = null;
      let postcodeFoundAt: string | null = null;
      let postcodeConfirms = false;
      let onAggregator = false;
      let looksParkedPage = false;
      let placeholder = false;
      let servedElsewhere = false;
      let thinPage = false;
      let nameAndPlace: NameAndPlaceCheck | undefined;
      let nameAndPlaceAt: string | null = null;
      if (fetched.ok) {
        // Read off the homepage we already have — no extra request.
        //
        // The host is the POST-redirect one, because a stored URL that 301s
        // into a directory has to be judged on where it actually lands:
        // pairing the final page's content with the pre-redirect host let such
        // a row escape isAggregatorHost entirely.
        //
        // The postcode is checked on the HOMEPAGE specifically, not taken from
        // findDisclosure below, because this signal revokes as well as
        // confirms and so must be recomputed identically on every pass.
        // Disclosure-path probing is first-pass-only, so keying off it would
        // read as absent from the second pass on and revoke every row it had
        // just confirmed.
        const text = visibleText(fetched.html);
        const host = hostOf(fetched.url);
        onAggregator = isAggregatorHost(host);
        looksParkedPage = looksParked(text);
        placeholder = row.evidence === 'assessed' && looksPlaceholder(text);
        servedElsewhere = row.evidence === 'assessed' && !hostNamer(row)(host);
        thinPage = pageTooThin(text);
        postcodeConfirms = Boolean(
          row.postcode && deps.hasPostcode(fetched.html, row.postcode),
        );
        if (postcodeConfirms) summary.corroborated++;
        if (onAggregator || looksParkedPage || placeholder || servedElsewhere) {
          summary.noSiteThere++;
        }

        // Attribute proof to the URL this row will STORE (the variant we
        // tried), not to fetched.url which is post-redirect. Otherwise a site
        // that 301s to an acquirer records evidence_url on the acquirer's
        // domain while url stays the original — a proof page that does not
        // belong to the URL it claims to prove.
        const found = await findDisclosure(
          row,
          { url: fetched.attemptedUrl, html: fetched.html },
          config,
          deps,
          summary,
        );
        crnFoundAt = found.crnFoundAt;
        postcodeFoundAt = found.postcodeFoundAt;

        // A number promotes it and a directory or holding page holds it anyway.
        if (
          row.evidence === 'name_and_place' &&
          !crnFoundAt &&
          !onAggregator &&
          !looksParkedPage
        ) {
          const recheck = await recheckNameAndPlace(
            row,
            {
              url: fetched.attemptedUrl,
              servedUrl: fetched.url,
              html: fetched.html,
            },
            config,
            deps,
            summary,
          );
          nameAndPlace = recheck.check;
          nameAndPlaceAt = recheck.proofAt;
          if (nameAndPlace === 'gone') summary.nameAndPlaceGone++;
          if (nameAndPlace === 'unknown') summary.nameAndPlaceUnread++;
        }
      }

      const result = revalidate({
        storedUrl: row.url,
        evidence: row.evidence,
        status: row.status,
        failureCount: row.failureCount,
        attemptedUrl: fetched.attemptedUrl,
        outcome: fetched.ok
          ? { ok: true }
          : { ok: false, reason: fetched.reason, status: fetched.status },
        crnFoundAt,
        postcodeFoundAt,
        postcodeConfirms,
        onAggregator,
        looksParked: looksParkedPage,
        placeholder,
        servedElsewhere,
        pageTooThin: thinPage,
        nameAndPlace,
        nameAndPlaceAt,
      });

      if (fetched.ok) {
        summary.live++;
        failureStreak = 0;
      } else if (result.hostAnswered) {
        // A host that refused us is still a host that answered, so it says
        // nothing about our egress. Counting these tripped the breaker on the
        // 665 same-origin franchise rows, which sit adjacent in the cursor:
        // one origin blocking us aborted the whole nightly slice and red-failed
        // the job with a diagnosis pointing at our network.
        failureStreak = 0;
      } else {
        failureStreak++;
      }
      if (result.status === 'dead') summary.dead++;
      if (!fetched.ok && fetched.reason === 'blocked_by_robots') {
        summary.robotsBlocked++;
      }
      if (result.evidence !== row.evidence) {
        // Direction matters now that a tier can be withdrawn. Lumping both
        // into `promoted` reported a mass unpublish as the run's best number.
        // Strictly, in both directions. registry_unconfirmed and
        // llm_adjudicated share a rung, so a lateral swap between them is
        // neither a promotion nor a withdrawal and must not inflate either.
        const before = evidenceRank(row.evidence);
        const after = evidenceRank(result.evidence);
        if (after > before) summary.promoted++;
        else if (after < before) summary.demoted++;
      }
      if (result.url !== row.url) summary.adoptedVariant++;

      // Checked BEFORE the dry-run short-circuit, so --dry-run previews the
      // same behaviour a real run would have — including stopping early. Behind
      // the `continue` it never fired at all, and a dry run against a broken
      // runner burned the whole slice's fetches proving nothing.
      // The `live === 0` half is load-bearing and was wrong to drop. Rows are
      // swept in checked_at order and CQC's file is alphabetical by provider,
      // so a defunct group can put 15 genuinely dead domains next to each
      // other — aborting there skips the rest of a slice that is working fine
      // and red-fails the job nightly. Requiring that NOTHING has succeeded
      // costs nothing against real broken egress, where nothing does.
      const abort =
        summary.live === 0 && failureStreak >= SYSTEMIC_FAILURE_STREAK;
      if (abort) {
        summary.systemicAbort = true;
        deps.log(
          `  ABORTING: ${failureStreak} consecutive rows unreachable and nothing has succeeded — this is our egress, not their sites.`,
        );
      }

      if (config.logRows) {
        deps.log(
          `  ${config.dryRun ? '[dry] ' : ''}${row.companyNumber} ${row.url} — ${result.note}`,
        );
      }

      if ((index + 1) % HEARTBEAT_ROWS === 0) {
        deps.log(
          `  … ${index + 1}/${rows.length} rows, ${summary.live} live, ${summary.dead} dead`,
        );
      }

      if (config.dryRun) {
        if (abort) break;
        continue;
      }
      const applied = await deps.applyResult(row, result);
      if (applied) summary.updated++;
      else summary.lockMissed++;
      // Stop BEFORE committing another 800 demotions, not after.
      if (abort) break;
    } catch (err) {
      summary.errored++;
      const raw = err instanceof Error ? err.message : String(err);
      // The error path needs the same gate as the success path — it was
      // unconditional, so one thrown fetch published a company/URL pair however
      // logRows was set. Redaction rather than a bare prefix swap because the
      // MESSAGE carries the address too: DNS failures quote the host, URL
      // parse errors quote the input.
      deps.log(
        config.logRows
          ? `  ERROR ${row.companyNumber} ${row.url}: ${raw}`
          : `  ERROR row ${index + 1}: ${redactRowIdentity(raw, row)}`,
      );
    }
  }

  return summary;
}
