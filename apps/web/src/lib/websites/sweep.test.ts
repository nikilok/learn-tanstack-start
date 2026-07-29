import { describe, expect, test } from 'bun:test';

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
  ...over,
});

const config = (over: Partial<SweepConfig> = {}): SweepConfig => ({
  maxRows: 10,
  delayMs: 0,
  maxDisclosurePaths: 2,
  dryRun: false,
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
      'https://www.example.co.uk/contact',
      'https://www.example.co.uk/contact-us',
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
    expect(probed).toEqual(['https://www.example.co.uk/contact']);
    expect(summary.disclosureFetches).toBe(1);
    expect(summary.promoted).toBe(1);
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
    const summary = await sweepWebsites(config({ dryRun: true }), h.deps);
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
      'https://www.caremark.co.uk/arun/contact',
      'https://www.caremark.co.uk/arun/contact-us',
    ]);
  });
});
