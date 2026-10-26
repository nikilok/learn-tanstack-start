import { describe, expect, setSystemTime, test } from 'bun:test';

import { pageShowsCompanyNumber } from './stated-numbers.ts';
import type { FetchedPage, SweepConfig, SweepDeps, SweepRow } from './sweep.ts';
import { SYSTEMIC_FAILURE_STREAK, sweepWebsites } from './sweep.ts';

const row = (over: Partial<SweepRow> = {}): SweepRow => ({
  companyNumber: '03260168',
  url: 'https://www.example.co.uk',
  status: 'verified',
  evidence: 'registry',
  failureCount: 0,
  postcode: 'SW1A 1AA',
  everChecked: false,
  evidenceUrl: null,
  confidence: '0.950',
  companyName: 'ACME WIDGETS LIMITED',
  sponsorNames: [],
  registerTowns: [],
  locality: null,
  ...over,
});

const config = (over: Partial<SweepConfig> = {}): SweepConfig => ({
  maxRows: 10,
  delayMs: 0,
  maxDisclosurePaths: 2,
  dryRun: false,
  logRows: false,
  ...over,
});

const live = (url: string, html = ''): FetchedPage => ({
  ok: true,
  url,
  html,
  attemptedUrl: url,
});

type Harness = {
  deps: SweepDeps;
  applied: { row: SweepRow; result: unknown }[];
  fetchedPaths: string[];
  logs: string[];
};

function harness(
  over: Partial<SweepDeps> & { rows?: SweepRow[] } = {},
): Harness {
  const applied: Harness['applied'] = [];
  const fetchedPaths: string[] = [];
  const logs: string[] = [];
  const rows = over.rows ?? [row()];
  const deps: SweepDeps = {
    selectRows: async () => rows,
    fetchSite: async (url) => live(url),
    fetchPage: async (url) => {
      fetchedPaths.push(url);
      return { ok: false, reason: 'http_error', attemptedUrl: url };
    },
    hasCompanyNumber: () => false,
    hasPostcode: () => false,
    applyResult: async (r, result) => {
      applied.push({ row: r, result });
      return true;
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, applied, fetchedPaths, logs };
}

describe('sweepWebsites', () => {
  test('stamps every selected row, whatever the outcome', async () => {
    const h = harness({ rows: [row(), row({ companyNumber: '09999999' })] });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.selected).toBe(2);
    expect(summary.updated).toBe(2);
    expect(h.applied).toHaveLength(2);
  });

  test('does not probe disclosure paths when the homepage carries the number', async () => {
    const h = harness({
      fetchSite: async (url) => live(url, 'Company No. 03260168'),
      hasCompanyNumber: () => true,
    });
    const summary = await sweepWebsites(config(), h.deps);
    expect(h.fetchedPaths).toHaveLength(0);
    expect(summary.disclosureFetches).toBe(0);
    expect(summary.promoted).toBe(1);
  });

  test('probes disclosure paths when the homepage does not', async () => {
    const h = harness();
    await sweepWebsites(config({ maxDisclosurePaths: 2 }), h.deps);
    expect(h.fetchedPaths).toEqual([
      'https://www.example.co.uk/privacy',
      'https://www.example.co.uk/privacy-policy',
    ]);
  });

  test('stops probing as soon as a disclosure page carries the number', async () => {
    const probed: string[] = [];
    const h = harness({
      fetchPage: async (url) => {
        probed.push(url);
        return live(url, 'Company No. 03260168');
      },
      hasCompanyNumber: (html) => html.includes('03260168'),
    });
    const summary = await sweepWebsites(
      config({ maxDisclosurePaths: 4 }),
      h.deps,
    );
    expect(probed).toEqual(['https://www.example.co.uk/privacy']);
    expect(summary.disclosureFetches).toBe(1);
    expect(summary.promoted).toBe(1);
  });

  test('with the shipped check, digit groups in statutory wording promote and a phone number does not', async () => {
    const evidenceAfter = async (footer: string) => {
      const h = harness({
        rows: [row({ evidence: 'postcode_on_page', everChecked: true })],
        fetchSite: async (url) => live(url, `<footer>${footer}</footer>`),
        hasCompanyNumber: pageShowsCompanyNumber,
      });
      await sweepWebsites(config(), h.deps);
      return (h.applied[0].result as { evidence: string }).evidence;
    };
    expect(await evidenceAfter('Acme Ltd. Company No. 0326 0168')).toBe(
      'crn_on_page',
    );
    expect(await evidenceAfter('Call us: 020 0326 0168')).toBe(
      'postcode_on_page',
    );
  });

  test('never re-probes a row that already has the number on file', async () => {
    // The proof cannot change, so later passes only need liveness. Re-probing
    // would multiply the request count across the whole table every run.
    const h = harness({ rows: [row({ evidence: 'crn_on_page' })] });
    const summary = await sweepWebsites(config(), h.deps);
    expect(h.fetchedPaths).toHaveLength(0);
    expect(summary.disclosureFetches).toBe(0);
  });

  test('probes on the first pass only, not on every pass forever', async () => {
    // Measured at ~1.6 extra fetches per row. Without this gate a row whose
    // legal pages carry no number keeps paying that cost every run to re-learn
    // the same negative — across the whole table, every night.
    const first = harness({ rows: [row({ everChecked: false })] });
    const a = await sweepWebsites(config(), first.deps);
    expect(a.disclosureFetches).toBeGreaterThan(0);

    const later = harness({ rows: [row({ everChecked: true })] });
    const b = await sweepWebsites(config(), later.deps);
    expect(b.disclosureFetches).toBe(0);
    expect(later.fetchedPaths).toHaveLength(0);
  });

  test('counts a dead row without writing a bad url', async () => {
    const h = harness({
      rows: [row({ failureCount: 1 })],
      fetchSite: async (url) => ({
        ok: false,
        reason: 'dns_or_refused',
        attemptedUrl: url,
      }),
    });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.dead).toBe(1);
    expect(summary.live).toBe(0);
  });

  test('counts robots-blocked separately from dead', async () => {
    const h = harness({
      fetchSite: async (url) => ({
        ok: false,
        reason: 'blocked_by_robots',
        attemptedUrl: url,
      }),
    });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.robotsBlocked).toBe(1);
    expect(summary.dead).toBe(0);
  });

  test('counts a variant adoption', async () => {
    const h = harness({
      fetchSite: async () => ({
        ok: true,
        url: 'https://example.co.uk',
        html: '',
        attemptedUrl: 'https://example.co.uk',
      }),
    });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.adoptedVariant).toBe(1);
  });

  test('writes nothing on a dry run but still reports what it would do', async () => {
    const h = harness();
    const summary = await sweepWebsites(
      config({ dryRun: true, logRows: true }),
      h.deps,
    );
    expect(h.applied).toHaveLength(0);
    expect(summary.updated).toBe(0);
    expect(summary.selected).toBe(1);
    expect(h.logs.some((l) => l.includes('[dry]'))).toBe(true);
  });

  test('a row that throws is counted and does not abort the slice', async () => {
    let call = 0;
    const h = harness({
      rows: [row(), row({ companyNumber: '09999999' })],
      fetchSite: async (url) => {
        call++;
        if (call === 1) throw new Error('boom');
        return live(url);
      },
    });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
    expect(summary.updated).toBe(1);
  });

  test('a rejected write counts as a lock miss, not an update', async () => {
    const h = harness({ applyResult: async () => false });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.lockMissed).toBe(1);
    expect(summary.updated).toBe(0);
  });

  test('paces between rows but not before the first', async () => {
    const sleeps: number[] = [];
    const h = harness({
      rows: [row(), row({ companyNumber: '09999999' })],
      hasCompanyNumber: () => true,
      fetchSite: async (url) => live(url, 'x'),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await sweepWebsites(config({ delayMs: 250 }), h.deps);
    expect(sleeps).toEqual([250]);
  });
});

describe('sweepWebsites — hardening', () => {
  test('stops the run once nothing is reachable, before committing the rest', async () => {
    // A runner with broken egress fails every fetch, and each row is committed
    // as it goes — a check at the END would diagnose it correctly with 900
    // demotions already written and sorted to the back of the cursor.
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({
      rows,
      fetchSite: async (url) => ({
        ok: false,
        reason: 'dns_or_refused',
        attemptedUrl: url,
      }),
    });
    const summary = await sweepWebsites(config({ maxRows: 60 }), h.deps);
    expect(summary.systemicAbort).toBe(true);
    expect(summary.updated).toBeLessThan(rows.length);
    expect(summary.updated).toBeLessThanOrEqual(SYSTEMIC_FAILURE_STREAK);
  });

  test('does not abort when failures are interleaved with successes', async () => {
    let n = 0;
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({
      rows,
      hasCompanyNumber: () => true,
      fetchSite: async (url) => {
        n++;
        return n % 5 === 0
          ? { ok: false, reason: 'dns_or_refused', attemptedUrl: url }
          : { ok: true, url, html: 'x', attemptedUrl: url };
      },
    });
    const summary = await sweepWebsites(config({ maxRows: 60 }), h.deps);
    expect(summary.systemicAbort).toBe(false);
    expect(summary.updated).toBe(60);
  });

  test('probes a franchise row against its own directory, not the franchisor', async () => {
    // 665 stored URLs carry a load-bearing path; probing the origin spends the
    // whole disclosure budget on the national site.
    const probed: string[] = [];
    const h = harness({
      rows: [row({ url: 'https://www.caremark.co.uk/arun' })],
      fetchSite: async (url) => live(url, ''),
      fetchPage: async (url) => {
        probed.push(url);
        return { ok: false, reason: 'http_error', attemptedUrl: url };
      },
    });
    await sweepWebsites(config({ maxDisclosurePaths: 2 }), h.deps);
    expect(probed).toEqual([
      'https://www.caremark.co.uk/arun/privacy',
      'https://www.caremark.co.uk/arun/privacy-policy',
    ]);
  });
});

describe('sweepWebsites — dry run parity', () => {
  test('a dry run aborts on broken egress exactly as a real run would', async () => {
    // The abort check sat behind the dry-run `continue`, so --dry-run burned
    // the whole slice's fetches and never reported systemicAbort.
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({
      rows,
      fetchSite: async (url) => ({
        ok: false,
        reason: 'dns_or_refused',
        attemptedUrl: url,
      }),
    });
    const summary = await sweepWebsites(
      config({ maxRows: 60, dryRun: true }),
      h.deps,
    );
    expect(summary.systemicAbort).toBe(true);
    expect(h.applied).toHaveLength(0);
    expect(summary.selected).toBe(60);
    expect(h.logs.some((l) => l.includes('ABORTING'))).toBe(true);
  });
});

describe('sweepWebsites — the breaker does not fire on a working slice', () => {
  test('a run of dead domains after successes does not abort', async () => {
    // Rows are swept in checked_at order and CQC's file is alphabetical by
    // provider, so a defunct group can put many dead domains side by side.
    // Aborting there would skip the rest of a slice that is working fine.
    let n = 0;
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({
      rows,
      hasCompanyNumber: () => true,
      fetchSite: async (url) => {
        n++;
        // First five answer, then a long run of genuinely dead domains.
        return n <= 5
          ? { ok: true, url, html: 'x', attemptedUrl: url }
          : { ok: false, reason: 'dns_or_refused', attemptedUrl: url };
      },
    });
    const summary = await sweepWebsites(config({ maxRows: 60 }), h.deps);
    expect(summary.systemicAbort).toBe(false);
    expect(summary.selected).toBe(60);
    expect(summary.updated).toBe(60);
  });

  test('but genuinely broken egress, where nothing succeeds, still aborts', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({
      rows,
      fetchSite: async (url) => ({
        ok: false,
        reason: 'dns_or_refused',
        attemptedUrl: url,
      }),
    });
    const summary = await sweepWebsites(config({ maxRows: 60 }), h.deps);
    expect(summary.systemicAbort).toBe(true);
    expect(summary.updated).toBeLessThanOrEqual(SYSTEMIC_FAILURE_STREAK);
  });
});

describe('sweepWebsites — logging must not leak the dataset', () => {
  test('no company number or url reaches the log when logRows is off', async () => {
    // The repo is public, so Actions logs are world-readable and a per-row line
    // is company_number -> url -> verdict: the enriched dataset itself.
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({
        companyNumber: String(i).padStart(8, '0'),
        url: `https://secret-${i}.example`,
      }),
    );
    const h = harness({ rows, fetchSite: async (url) => live(url, '') });
    await sweepWebsites(config({ maxRows: 60 }), h.deps);
    const printed = h.logs.join('\n');
    for (const r of rows) {
      expect(printed).not.toContain(r.companyNumber);
      expect(printed).not.toContain(r.url);
    }
  });

  test('the heartbeat still reports progress, in aggregate only', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({ rows, fetchSite: async (url) => live(url, '') });
    await sweepWebsites(config({ maxRows: 60 }), h.deps);
    expect(h.logs.some((l) => l.includes('50/60 rows'))).toBe(true);
  });

  test('a dry run WITHOUT --verbose is also silent, so CI cannot leak', async () => {
    // The workflow dispatches dry runs too, and those logs are just as public.
    const h = harness();
    await sweepWebsites(config({ dryRun: true }), h.deps);
    expect(h.logs.join('\n')).not.toContain('03260168');
  });

  test('--verbose prints the detail, for a human at a terminal', async () => {
    const h = harness();
    await sweepWebsites(config({ dryRun: true, logRows: true }), h.deps);
    expect(h.logs.join('\n')).toContain('03260168');
  });

  test('a LIVE run never prints rows by default', async () => {
    const h = harness();
    await sweepWebsites(config({ dryRun: false }), h.deps);
    expect(h.logs.join('\n')).not.toContain('03260168');
  });
});

describe('sweepWebsites — the error path must not leak either', () => {
  const throwing = (message: string) =>
    harness({
      rows: [
        row({ companyNumber: '03260168', url: 'https://secret-acme.co.uk' }),
      ],
      fetchSite: async () => {
        throw new Error(message);
      },
    });

  test('a thrown fetch prints no identifiers by default', async () => {
    // This path was unconditional, so one error published a company/URL pair
    // to a public Actions log however logRows was set.
    const h = throwing('boom');
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
    const printed = h.logs.join('\n');
    expect(printed).not.toContain('03260168');
    expect(printed).not.toContain('secret-acme.co.uk');
    expect(printed).toContain('ERROR row 1');
  });

  test('an error message that quotes the address is redacted too', async () => {
    // DNS and URL-parse errors name what failed, so omitting the prefix alone
    // would still leak through the message.
    const h = throwing('getaddrinfo ENOTFOUND secret-acme.co.uk');
    await sweepWebsites(config(), h.deps);
    const printed = h.logs.join('\n');
    expect(printed).not.toContain('secret-acme.co.uk');
    expect(printed).toContain('<host>');
  });

  test('--verbose still gives a human the full error', async () => {
    const h = throwing('boom');
    await sweepWebsites(config({ logRows: true }), h.deps);
    const printed = h.logs.join('\n');
    expect(printed).toContain('03260168');
    expect(printed).toContain('secret-acme.co.uk');
  });
});

describe('the sweep computes its signals from the right inputs', () => {
  test('judges the host AFTER redirects, not the one we asked for', async () => {
    // The regression this locks: pairing the final page's content with the
    // PRE-redirect host let a row that 301s into a directory escape the
    // deny-list entirely, while the listing itself supplied the confirming
    // signal — publishing a carehome.co.uk page as a company's website.
    const h = harness({
      rows: [row({ url: 'https://www.beachcrofthomes.co.uk' })],
      fetchSite: async () => ({
        ok: true,
        url: 'https://www.carehome.co.uk/carehome.cfm/id/12345',
        attemptedUrl: 'https://www.beachcrofthomes.co.uk',
        html: '<html><body>Beachcroft Homes</body></html>',
      }),
      hasPostcode: () => true,
    });
    await sweepWebsites(config(), h.deps);
    const result = h.applied[0].result as { status: string; evidence: string };
    // Judged as a directory: held back, and NOT promoted off the listing.
    expect(result.status).toBe('candidate');
    expect(result.evidence).toBe('registry');
  });

  test('confirms on the registered postcode found on the homepage', async () => {
    const h = harness({
      rows: [row({ postcode: 'SW1A 1AA' })],
      fetchSite: async (url) => ({
        ok: true,
        url,
        attemptedUrl: url,
        html: '<html><body>Registered office: SW1A 1AA</body></html>',
      }),
      hasPostcode: () => true,
    });
    const summary = await sweepWebsites(config(), h.deps);
    const result = h.applied[0].result as { evidence: string };
    expect(result.evidence).toBe('registry_confirmed');
    expect(summary.corroborated).toBe(1);
  });

  test('counts a withdrawal as demoted, never as promoted', async () => {
    // A mass withdrawal reported under the run's healthiest-looking metric is
    // how a silent unpublish stays invisible.
    //
    // The page has to be SUBSTANTIAL for a withdrawal to happen at all: a
    // cookie wall or a JS shell says nothing about whether the site still
    // publishes the address, and unpublishing off one would make the link
    // flicker. That guard is what the padding here is defeating.
    const realPage = `<html><body>${'Home About us Our care Careers Contact. '.repeat(60)}</body></html>`;
    const h = harness({
      rows: [row({ evidence: 'registry_confirmed', confidence: '0.970' })],
      fetchSite: async (url) => ({
        ok: true,
        url,
        attemptedUrl: url,
        html: realPage,
      }),
      hasPostcode: () => false,
    });
    const summary = await sweepWebsites(config(), h.deps);
    expect(summary.demoted).toBe(1);
    expect(summary.promoted).toBe(0);
  });
});

describe("a name_and_place row's re-check", () => {
  const SITE = 'https://www.qmx.co.uk';
  const PROOF = `${SITE}/privacy`;
  /** Enough text that a page missing the proof says it is missing. */
  const filler = 'Clinical data for practices across the north. '.repeat(40);
  const html = (text: string) =>
    `<html><body><nav><a href="/services">Services</a></nav><p>${text}</p></body></html>`;
  const proved = row({
    companyNumber: '09990117',
    url: SITE,
    evidence: 'name_and_place',
    evidenceUrl: PROOF,
    confidence: '0.900',
    everChecked: true,
    postcode: 'HG1 9ZQ',
    companyName: 'QUILLMERE ANALYTICS LIMITED',
    registerTowns: ['Harrogate'],
    locality: 'Harrogate',
  });
  const NAME = 'This site is run by Quillmere Analytics Ltd.';

  /** A sweep of one row: the homepage and pages given, every other page not there. */
  const sweepOf = async (
    over: Partial<SweepRow>,
    homepage: string,
    pages: Record<string, FetchedPage>,
    deps: Partial<SweepDeps> = {},
  ) => {
    const fetched: string[] = [];
    const h = harness({
      rows: [{ ...proved, ...over }],
      fetchSite: async (url) => live(url, homepage),
      fetchPage: async (url) => {
        fetched.push(url);
        return (
          pages[url] ?? {
            ok: false,
            reason: 'http_error',
            status: 404,
            attemptedUrl: url,
          }
        );
      },
      ...deps,
    });
    const summary = await sweepWebsites(config(), h.deps);
    const result = h.applied[0].result as {
      status: string;
      evidence: string;
      confidence: string;
    };
    return { summary, result, fetched };
  };

  test('the proof still on its page keeps the row published, reading only that page', async () => {
    const { result, fetched } = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, html(`${NAME} ${filler}`)),
    });
    expect(result).toMatchObject({
      status: 'verified',
      evidence: 'name_and_place',
    });
    expect(fetched).toEqual([PROOF]);
  });

  test('the name gone from every page read holds the row back, the tier kept', async () => {
    const { result, summary, fetched } = await sweepOf(
      {},
      html(`${filler} Harrogate`),
      { [PROOF]: live(PROOF, html(filler)) },
    );
    expect(result).toMatchObject({
      status: 'candidate',
      evidence: 'name_and_place',
      confidence: '0.900',
    });
    expect(summary.nameAndPlaceGone).toBe(1);
    // The proof page, then the walk's nine fixed paths, bar the proof page itself.
    expect(fetched).toHaveLength(9);
  });

  test('the place gone is as good as the name gone', async () => {
    const { result } = await sweepOf({}, html(filler), {
      [PROOF]: live(PROOF, html(`${NAME} ${filler}`)),
    });
    expect(result.status).toBe('candidate');
  });

  test('the proof found again on another page of the walk', async () => {
    const { result } = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, html(filler)),
      [`${SITE}/terms`]: live(`${SITE}/terms`, html(NAME)),
    });
    expect(result.status).toBe('verified');
  });

  test('a proof page that would not answer is not evidence of absence', async () => {
    const { result, summary } = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: { ok: false, reason: 'timeout', attemptedUrl: PROOF },
    });
    expect(result.status).toBe('verified');
    expect(summary.nameAndPlaceUnread).toBe(1);
  });

  test('nor is a thin proof page, a thin homepage, or a walked page that refused us', async () => {
    const thinProof = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, html('Accept cookies')),
    });
    expect(thinProof.result.status).toBe('verified');
    const thinHome = await sweepOf({}, html('Harrogate'), {
      [PROOF]: live(PROOF, html(filler)),
    });
    expect(thinHome.result.status).toBe('verified');
    const refused = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, html(filler)),
      [`${SITE}/terms`]: {
        ok: false,
        reason: 'http_error',
        status: 403,
        attemptedUrl: `${SITE}/terms`,
      },
    });
    expect(refused.result.status).toBe('verified');
  });

  test('a proof page robots.txt now closes is unread; a walked file is not there', async () => {
    const closed = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: { ok: false, reason: 'blocked_by_robots', attemptedUrl: PROOF },
    });
    expect(closed.result.status).toBe('verified');
    const file = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, html(filler)),
      [`${SITE}/terms`]: {
        ok: false,
        reason: 'not_html',
        attemptedUrl: `${SITE}/terms`,
      },
    });
    expect(file.result.status).toBe('candidate');
  });

  describe('a homepage that shows a plain fetch nothing', () => {
    const shell = '<html><body><div id="root"></div></body></html>';
    const notThere = (url: string): FetchedPage => ({
      ok: false,
      reason: 'http_error',
      status: 404,
      attemptedUrl: url,
    });

    test('is read in a browser, as discovery read it, and so is its walk', async () => {
      const rendered: string[] = [];
      const { result, summary, fetched } = await sweepOf(
        {},
        shell,
        {},
        {
          renderPage: async (url) => {
            rendered.push(url);
            if (url === SITE)
              return live(`${SITE}/`, html(`${filler} Harrogate`));
            if (url === PROOF) return live(PROOF, html(`${NAME} ${filler}`));
            return notThere(url);
          },
        },
      );
      expect(result).toMatchObject({
        status: 'verified',
        evidence: 'name_and_place',
      });
      expect(summary.nameAndPlaceRendered).toBe(1);
      expect(rendered).toEqual([SITE, PROOF]);
      expect(fetched).toEqual([]);
    });

    test('restores a held row once the browser reads the proof', async () => {
      const { result } = await sweepOf(
        { status: 'candidate' },
        shell,
        {},
        {
          renderPage: async (url) =>
            url === SITE
              ? live(`${SITE}/`, html(`${NAME} ${filler} Harrogate`))
              : notThere(url),
        },
      );
      expect(result.status).toBe('verified');
    });

    test('a render that fails, or lands on a directory, reads nothing: the row stays as it was', async () => {
      for (const shown of [
        { ok: false, reason: 'timeout', attemptedUrl: SITE } as FetchedPage,
        live(
          'https://www.yell.com/biz/quillmere',
          html(`${NAME} ${filler} Harrogate`),
        ),
      ]) {
        const { result, summary } = await sweepOf(
          { status: 'candidate' },
          shell,
          {},
          { renderPage: async () => shown },
        );
        expect(result.status).toBe('candidate');
        expect(summary).toMatchObject({
          nameAndPlaceRendered: 1,
          nameAndPlaceUnread: 1,
        });
      }
    });

    test('a site too slow for its visit is unread, never gone', async () => {
      const rendered: string[] = [];
      try {
        const { result, summary } = await sweepOf(
          {},
          shell,
          {},
          {
            renderPage: async (url) => {
              rendered.push(url);
              // Every page takes most of the visit.
              setSystemTime(new Date(Date.now() + 60_000));
              return url === SITE
                ? live(`${SITE}/`, html(`${filler} Harrogate`))
                : notThere(url);
            },
          },
        );
        expect(rendered).toEqual([SITE, PROOF]);
        expect(result.status).toBe('verified');
        expect(summary).toMatchObject({
          nameAndPlaceGone: 0,
          nameAndPlaceUnread: 1,
        });
      } finally {
        setSystemTime();
      }
    });

    test('a homepage that reads normally is never rendered', async () => {
      const { summary } = await sweepOf(
        {},
        html(`${filler} Harrogate`),
        { [PROOF]: live(PROOF, html(`${NAME} ${filler}`)) },
        {
          renderPage: async () => {
            throw new Error('rendered');
          },
        },
      );
      expect(summary).toMatchObject({ nameAndPlaceRendered: 0, errored: 0 });
    });
  });

  test('a homepage whose menu its scripts build is unread: a proof read in a browser is never withdrawn by a raw read', async () => {
    const { result, summary } = await sweepOf(
      {},
      `<html><body><p>${filler} Harrogate</p></body></html>`,
      { [PROOF]: live(PROOF, html(filler)) },
    );
    expect(result.status).toBe('verified');
    expect(summary.nameAndPlaceUnread).toBe(1);
  });

  test('a row held back stays held while its proof cannot be read, and returns when it can', async () => {
    const unread = await sweepOf(
      { status: 'candidate' },
      html(`${filler} Harrogate`),
      {
        [PROOF]: { ok: false, reason: 'timeout', attemptedUrl: PROOF },
      },
    );
    expect(unread.result.status).toBe('candidate');
    const read = await sweepOf(
      { status: 'candidate' },
      html(`${filler} Harrogate`),
      {
        [PROOF]: live(PROOF, html(`${NAME} ${filler}`)),
      },
    );
    expect(read.result.status).toBe('verified');
  });

  test('the officer arm re-reads the officers, resigned ones included', async () => {
    const team = 'https://www.quillmere.co.uk/team';
    const asked: string[] = [];
    const { result } = await sweepOf(
      { url: 'https://www.quillmere.co.uk', evidenceUrl: team },
      html(`${filler} Harrogate`),
      { [team]: live(team, html(`Idris Tallowmere, founder. ${filler}`)) },
      {
        officers: async (companyNumber) => {
          asked.push(companyNumber);
          return [{ forename: 'IDRIS', surname: 'TALLOWMERE', current: false }];
        },
      },
    );
    expect(result.status).toBe('verified');
    expect(asked).toEqual(['09990117']);
  });

  test('asks for officers only once the proof page has been read', async () => {
    const Q = 'https://www.quillmere.co.uk';
    const asked: string[] = [];
    const { result, fetched } = await sweepOf(
      { url: Q, evidenceUrl: `${Q}/privacy` },
      html(`${filler} Harrogate`),
      { [`${Q}/privacy`]: live(`${Q}/privacy`, html(`${NAME} ${filler}`)) },
      {
        officers: async (companyNumber) => {
          asked.push(companyNumber);
          return [];
        },
      },
    );
    expect(result.status).toBe('verified');
    expect(fetched).toEqual([`${Q}/privacy`]);
    expect(asked).toEqual([]);
  });

  test('a bot challenge, on the homepage, the proof page or a walked page, leaves it unread', async () => {
    const challenge = html(
      `Just a moment... Checking your browser before accessing. ${filler}`,
    );
    const home = await sweepOf({}, challenge, {
      [PROOF]: live(PROOF, html(filler)),
    });
    expect(home.result.status).toBe('verified');
    const proof = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, challenge),
    });
    expect(proof.result.status).toBe('verified');
    const walked = await sweepOf({}, html(`${filler} Harrogate`), {
      [PROOF]: live(PROOF, html(filler)),
      [`${SITE}/terms`]: live(`${SITE}/terms`, challenge),
    });
    expect(walked.result.status).toBe('verified');
  });

  test('a proof that moved is read where it is now, and that page is kept', async () => {
    const terms = `${SITE}/terms`;
    const { result } = await sweepOf({}, html(`${filler} Harrogate`), {
      [terms]: live(terms, html(`${NAME} ${filler}`)),
    });
    expect(result).toMatchObject({ status: 'verified', evidenceUrl: terms });
  });

  test('a held row a failed fetch interrupted stays held until its proof is read', async () => {
    const { result } = await sweepOf(
      { status: 'unreachable' },
      html(`${filler} Harrogate`),
      { [PROOF]: { ok: false, reason: 'timeout', attemptedUrl: PROOF } },
    );
    expect(result.status).toBe('candidate');
  });

  test('with the proof page gone, the officers still decide it once every page is read', async () => {
    const Q = 'https://www.quillmere.co.uk';
    const { result } = await sweepOf(
      { url: Q, evidenceUrl: `${Q}/team`, status: 'candidate' },
      html(`${filler} Harrogate. Idris Tallowmere, director.`),
      {},
      {
        officers: async () => [
          { forename: 'IDRIS', surname: 'TALLOWMERE', current: true },
        ],
      },
    );
    expect(result.status).toBe('verified');
  });

  test('without the officer lookup the officer arm is unread, never gone', async () => {
    const { result, summary } = await sweepOf(
      {
        url: 'https://www.quillmere.co.uk',
        evidenceUrl: 'https://www.quillmere.co.uk/team',
      },
      html(`${filler} Harrogate`),
      {},
    );
    expect(result.status).toBe('verified');
    expect(summary.nameAndPlaceUnread).toBe(1);
  });

  test('its number on the site promotes it, with no re-check', async () => {
    const { result, fetched } = await sweepOf(
      {},
      html(`${filler} Company No. 09990117`),
      {},
      { hasCompanyNumber: (page) => page.includes('09990117') },
    );
    expect(result.evidence).toBe('crn_on_page');
    expect(fetched).toEqual([]);
  });

  test('other tiers are never re-checked', async () => {
    const { fetched } = await sweepOf(
      { evidence: 'postcode_on_page', confidence: '0.850' },
      html(filler),
      {},
    );
    expect(fetched).toEqual([]);
  });
});
