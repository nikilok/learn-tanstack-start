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
import type { Renderer } from './web-render.ts';

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

/** The sweep's dependencies against this database, logging through `log`; without `officers` the officer arm is never re-read, and without `renderer` no page is read in a browser. */
export function makeSweepDeps(
  sql: Parameters<typeof makeSelectRows>[0],
  log: (message: string) => void,
  officers?: SweepDeps['officers'],
  renderer?: Pick<Renderer, 'visit'>,
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
    officers,
    // A visit of its own for each page, as the sweep asks for them one at a time.
    renderPage: renderer
      ? async (url) => {
          const visit = renderer.visit();
          try {
            return toFetchedPage(await visit.render(url), url);
          } finally {
            await visit.close();
          }
        }
      : undefined,
    applyResult: makeApplyResult(sql),
    sleep: makeSleep(),
    log,
  };
}
