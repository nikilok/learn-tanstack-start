/**
 * The revalidation sweep's production dependencies, built outside the script so
 * a test can check what is bound. No I/O until a dependency is called.
 */

import { pageHasPostcode } from '../../src/lib/websites/extract.ts';
import {
  makeApplyResult,
  makeSelectRows,
  makeSleep,
} from '../../src/lib/websites/sql.ts';
import { pageShowsCompanyNumber } from '../../src/lib/websites/stated-numbers.ts';
import type { FetchedPage, SweepDeps } from '../../src/lib/websites/sweep.ts';
import { fetchPage, fetchSite, type SiteFetch } from './web-fetch.ts';

/** Adapt web-fetch's result to the shape the orchestrator asks for, so the
 *  sweep never has to know about HTTP. */
function toFetchedPage(result: SiteFetch, requested: string): FetchedPage {
  if (result.ok) {
    return {
      ok: true,
      url: result.url,
      html: result.html,
      attemptedUrl: result.attemptedUrl,
    };
  }
  return {
    ok: false,
    reason: result.reason,
    attemptedUrl: result.attemptedUrl ?? requested,
    status: result.status,
  };
}

/** The sweep's dependencies against this database, logging through `log`. */
export function makeSweepDeps(
  sql: Parameters<typeof makeSelectRows>[0],
  log: (message: string) => void,
): SweepDeps {
  return {
    selectRows: makeSelectRows(sql),
    fetchSite: async (url) => toFetchedPage(await fetchSite(url), url),
    fetchPage: async (url) =>
      toFetchedPage(
        { ...(await fetchPage(url)), attempts: 1, attemptedUrl: url },
        url,
      ),
    hasCompanyNumber: pageShowsCompanyNumber,
    hasPostcode: pageHasPostcode,
    applyResult: makeApplyResult(sql),
    sleep: makeSleep(),
    log,
  };
}
