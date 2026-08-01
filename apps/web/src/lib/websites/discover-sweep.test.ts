import { describe, expect, test } from 'bun:test';

import type { CandidateProbe, DiscoveryOutcome } from './discover';
import type {
  DiscoveryConfig,
  DiscoveryDeps,
  DiscoveryRow,
  SearchResult,
} from './discover-sweep';
import { discoverWebsites, SEARCH_FAILURE_STREAK } from './discover-sweep';

const row = (over: Partial<DiscoveryRow> = {}): DiscoveryRow => ({
  companyNumber: '03260168',
  companyName: 'BRENDONCARE FOUNDATION LIMITED',
  town: 'Winchester',
  postcode: 'SO22 5AZ',
  ...over,
});

const config = (over: Partial<DiscoveryConfig> = {}): DiscoveryConfig => ({
  maxRows: 10,
  maxSearches: 100,
  delayMs: 0,
  dryRun: false,
  ...over,
});

const probe = (over: Partial<CandidateProbe> = {}): CandidateProbe => ({
  url: 'https://example.co.uk',
  crnFound: false,
  postcodeFound: false,
  onAggregator: false,
  parked: false,
  ...over,
});

type Harness = {
  deps: DiscoveryDeps;
  banked: { companyNumber: string; urls: string[] }[];
  written: { row: DiscoveryRow; outcome: DiscoveryOutcome }[];
  probed: string[];
  logs: string[];
};

function harness(
  over: Partial<DiscoveryDeps> & {
    rows?: DiscoveryRow[];
    urls?: string[];
    probes?: Record<string, CandidateProbe | null>;
  } = {},
): Harness {
  const banked: Harness['banked'] = [];
  const written: Harness['written'] = [];
  const probed: string[] = [];
  const logs: string[] = [];
  const urls = over.urls ?? ['https://a.co.uk', 'https://b.co.uk'];
  const deps: DiscoveryDeps = {
    selectRows: async () => over.rows ?? [row()],
    search: async (): Promise<SearchResult> => ({ ok: true, urls }),
    bankCandidates: async (companyNumber, list) => {
      banked.push({ companyNumber, urls: list });
    },
    probe: async (_row, url) => {
      probed.push(url);
      return over.probes
        ? (over.probes[url] ?? probe({ url }))
        : probe({ url });
    },
    write: async (r, outcome) => {
      written.push({ row: r, outcome });
      return true;
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, banked, written, probed, logs };
}

describe('discoverWebsites', () => {
  test('banks the results BEFORE fetching any of them', async () => {
    // The credit is spent the moment the results arrive. A run that dies
    // mid-fetch must not make the next one pay for the same company again.
    const order: string[] = [];
    const h = harness({
      bankCandidates: async () => {
        order.push('bank');
      },
      probe: async (_row, url) => {
        order.push('probe');
        return probe({ url });
      },
    });
    await discoverWebsites(config(), h.deps);
    expect(order[0]).toBe('bank');
    expect(order.slice(1).every((step) => step === 'probe')).toBe(true);
  });

  test('stops fetching once the registration number is found', async () => {
    // Nothing below it can beat the company identifying itself, so every
    // further fetch is spent finding something it cannot use.
    const h = harness({
      urls: ['https://a.co.uk', 'https://b.co.uk', 'https://c.co.uk'],
      probes: {
        'https://a.co.uk': probe({ url: 'https://a.co.uk', crnFound: true }),
      },
    });
    const summary = await discoverWebsites(config(), h.deps);
    expect(h.probed).toEqual(['https://a.co.uk']);
    expect(summary.candidateFetches).toBe(1);
    expect(summary.foundByNumber).toBe(1);
  });

  test('keeps fetching past a directory listing that carries the number', async () => {
    // The early exit must not fire on a page the decision will discard, or a
    // listing hides the company's real site further down the results.
    const h = harness({
      urls: ['https://www.endole.co.uk/company/03260168', 'https://real.co.uk'],
      probes: {
        'https://www.endole.co.uk/company/03260168': probe({
          url: 'https://www.endole.co.uk/company/03260168',
          crnFound: true,
          onAggregator: true,
        }),
        'https://real.co.uk': probe({
          url: 'https://real.co.uk',
          postcodeFound: true,
        }),
      },
    });
    const summary = await discoverWebsites(config(), h.deps);
    expect(h.probed).toHaveLength(2);
    expect(h.written[0].outcome.url).toBe('https://real.co.uk');
    expect(summary.foundByAddress).toBe(1);
  });

  test('writes a not-found outcome rather than skipping the company', async () => {
    // The row still has to exist, or the next run searches it again and pays
    // for the same answer.
    const h = harness();
    const summary = await discoverWebsites(config(), h.deps);
    expect(summary.foundNothing).toBe(1);
    expect(h.written[0].outcome.evidence).toBe('none');
  });

  test('never spends a credit on an unsearchable name', async () => {
    const h = harness({ rows: [row({ companyName: 'LIMITED' })] });
    const summary = await discoverWebsites(config(), h.deps);
    expect(summary.unsearchable).toBe(1);
    expect(summary.searched).toBe(0);
    expect(h.banked).toEqual([]);
  });

  test('stops the whole run when the balance is exhausted', async () => {
    // Every later query would fail identically and the window is finite.
    const h = harness({
      rows: [row(), row({ companyNumber: '02' }), row({ companyNumber: '03' })],
      search: async () => ({ ok: false, reason: 'out_of_credits' }),
    });
    const summary = await discoverWebsites(config(), h.deps);
    expect(summary.stoppedEarly).toBe('out_of_credits');
    expect(summary.searched).toBe(1);
  });

  test('stops when searches fail in a run, without blaming the data', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({
      rows,
      search: async () => ({ ok: false, reason: 'network' }),
    });
    const summary = await discoverWebsites(config({ maxRows: 30 }), h.deps);
    expect(summary.stoppedEarly).toBe('search_failing');
    expect(summary.searched).toBe(SEARCH_FAILURE_STREAK);
  });

  test('honours the search budget even with rows left', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({ rows });
    const summary = await discoverWebsites(
      config({ maxRows: 10, maxSearches: 3 }),
      h.deps,
    );
    expect(summary.searched).toBe(3);
    expect(summary.stoppedEarly).toBe('budget');
  });

  test('a dry run spends credits but writes nothing', async () => {
    // Searching is the only way to see what a run would decide, so a dry run
    // still queries — it just must not touch the database.
    const h = harness();
    const summary = await discoverWebsites(config({ dryRun: true }), h.deps);
    expect(summary.searched).toBe(1);
    expect(h.banked).toEqual([]);
    expect(h.written).toEqual([]);
    expect(summary.written).toBe(0);
  });

  test('logs counts only, never a company or a url', async () => {
    // CI logs on this repo are world-readable, and a company-to-URL pair is
    // the dataset this pipeline exists to produce.
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ companyNumber: String(i).padStart(8, '0') }),
    );
    const h = harness({ rows, urls: ['https://secret-domain.co.uk'] });
    await discoverWebsites(config({ maxRows: 25 }), h.deps);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).not.toContain('secret-domain');
      expect(line).not.toContain('BRENDONCARE');
      expect(line).not.toMatch(/\d{8}/);
    }
  });

  test('one company throwing does not take down the run', async () => {
    let call = 0;
    const h = harness({
      rows: [row(), row({ companyNumber: '02' })],
      probe: async (_row, url) => {
        call += 1;
        if (call === 1) throw new Error('socket hang up');
        return probe({ url });
      },
    });
    const summary = await discoverWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
    expect(summary.selected).toBe(2);
  });
});
