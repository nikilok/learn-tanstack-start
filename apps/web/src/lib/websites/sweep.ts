/**
 * Revalidation sweep orchestrator. Pure but for the dependencies injected into
 * it, mirroring lib/phase5/sweep.ts, so the control flow is testable without a
 * network or a database.
 *
 * One bounded slice per run, ordered by `checked_at ASC NULLS FIRST`: a row
 * never checked sorts first, and every processed row is stamped, so the cursor
 * rotates through the table without needing to remember where it got to.
 */

import type { WebsiteEvidence, WebsiteStatus } from './decide.ts';
import { DISCLOSURE_PATHS } from './fetch-policy.ts';
import type { RevalidateFailure, RevalidateResult } from './revalidate.ts';
import { revalidate } from './revalidate.ts';

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
};

export type FetchedPage =
  | { ok: true; url: string; html: string; attemptedUrl: string }
  | { ok: false; reason: RevalidateFailure; attemptedUrl: string };

export type SweepDeps = {
  selectRows(maxRows: number): Promise<SweepRow[]>;
  /** Fetch a site, trying host and scheme variants. */
  fetchSite(url: string): Promise<FetchedPage>;
  /** Fetch one exact URL, no variants — used for disclosure paths. */
  fetchPage(url: string): Promise<FetchedPage>;
  hasCompanyNumber(html: string, companyNumber: string): boolean;
  hasPostcode(html: string, postcode: string): boolean;
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
};

export type SweepSummary = {
  selected: number;
  live: number;
  dead: number;
  promoted: number;
  adoptedVariant: number;
  robotsBlocked: number;
  disclosureFetches: number;
  updated: number;
  lockMissed: number;
  errored: number;
};

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
    const origin = new URL(homepage.url).origin;
    for (const path of DISCLOSURE_PATHS.slice(0, config.maxDisclosurePaths)) {
      await deps.sleep(config.delayMs);
      summary.disclosureFetches++;
      const page = await deps.fetchPage(`${origin}${path}`);
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
    updated: 0,
    lockMissed: 0,
    errored: 0,
  };

  const rows = await deps.selectRows(config.maxRows);
  summary.selected = rows.length;

  for (const [index, row] of rows.entries()) {
    if (index > 0) await deps.sleep(config.delayMs);
    try {
      const fetched = await deps.fetchSite(row.url);

      let crnFoundAt: string | null = null;
      let postcodeFoundAt: string | null = null;
      if (fetched.ok) {
        const found = await findDisclosure(
          row,
          { url: fetched.url, html: fetched.html },
          config,
          deps,
          summary,
        );
        crnFoundAt = found.crnFoundAt;
        postcodeFoundAt = found.postcodeFoundAt;
      }

      const result = revalidate({
        storedUrl: row.url,
        evidence: row.evidence,
        status: row.status,
        failureCount: row.failureCount,
        attemptedUrl: fetched.attemptedUrl,
        outcome: fetched.ok
          ? { ok: true }
          : { ok: false, reason: fetched.reason },
        crnFoundAt,
        postcodeFoundAt,
      });

      if (fetched.ok) summary.live++;
      if (result.status === 'dead') summary.dead++;
      if (!fetched.ok && fetched.reason === 'blocked_by_robots') {
        summary.robotsBlocked++;
      }
      if (result.evidence !== row.evidence) summary.promoted++;
      if (result.url !== row.url) summary.adoptedVariant++;

      if (config.dryRun) {
        deps.log(`  [dry] ${row.companyNumber} ${row.url} — ${result.note}`);
        continue;
      }
      const applied = await deps.applyResult(row, result);
      if (applied) summary.updated++;
      else summary.lockMissed++;
    } catch (err) {
      summary.errored++;
      deps.log(
        `  ERROR ${row.companyNumber} ${row.url}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return summary;
}
