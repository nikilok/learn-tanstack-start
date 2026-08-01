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
  bankedCandidates: null,
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
  attempts: string[];
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
  const attempts: string[] = [];
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
      if (over.probes && url in over.probes) return over.probes[url];
      return probe({ url });
    },
    write: async (r, outcome) => {
      written.push({ row: r, outcome });
      return true;
    },
    markAttempt: async (companyNumber) => {
      attempts.push(companyNumber);
    },
    sleep: async () => {},
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, banked, written, probed, attempts, logs };
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
    // Zero, not one. A 402 is the balance refusing the request, so nothing was
    // billed — and this counter is the credits_spent figure reconciled against
    // the invoice, not a count of requests attempted.
    expect(summary.searched).toBe(0);
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
    // The streak counts failed ATTEMPTS; searched counts what was charged, and
    // a network error never reached the provider to be billed.
    expect(summary.searched).toBe(0);
    expect(summary.errored).toBe(SEARCH_FAILURE_STREAK - 1);
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

  test('a company that throws after banking stays retryable', async () => {
    // The defect this locks: candidates are banked before any page is
    // fetched, and the selector used to exclude every company that had a row.
    // One socket hang-up therefore left the company at `pending` with its
    // credit spent and its answer never written — invisible to every future
    // slice, permanently.
    const h = harness({
      probe: async () => {
        throw new Error('socket hang up');
      },
    });
    await discoverWebsites(config(), h.deps);
    expect(h.banked).toHaveLength(1);

    // The next slice hands the row back WITH its banked candidates, and the
    // retry must not buy them again.
    let searched = 0;
    const retry = harness({
      rows: [row({ bankedCandidates: ['https://a.co.uk'] })],
      search: async () => {
        searched += 1;
        return { ok: true, urls: [] };
      },
      probes: {
        'https://a.co.uk': probe({
          url: 'https://a.co.uk',
          postcodeFound: true,
        }),
      },
    });
    const summary = await discoverWebsites(config(), retry.deps);
    expect(searched).toBe(0);
    expect(summary.searched).toBe(0);
    expect(summary.retried).toBe(1);
    expect(summary.foundByAddress).toBe(1);
    expect(retry.written[0].outcome.url).toBe('https://a.co.uk');
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

describe('a credit already spent is never thrown away', () => {
  test('candidates that cannot be FETCHED leave the row undecided, not `none`', async () => {
    // The distinction the whole retry design rests on. "We read the pages and
    // none of them proved anything" is an answer worth storing. "We could not
    // read any of them" is not, and storing it as one writes a permanent
    // status='none' that no selector revisits — the sweep needs url IS NOT
    // NULL and this job only readmits `pending`. One flaky slice would
    // otherwise write off every company in it on a DNS wobble, credit spent.
    const h = harness({
      urls: ['https://a.co.uk', 'https://b.co.uk'],
      probes: { 'https://a.co.uk': null, 'https://b.co.uk': null },
    });
    const summary = await discoverWebsites(config(), h.deps);

    expect(summary.unreadable).toBe(1);
    expect(h.written).toHaveLength(0);
    expect(summary.foundNothing).toBe(0);
    // Banked, so the retry costs nothing.
    expect(h.banked).toHaveLength(1);
    expect(h.attempts).toEqual(['03260168']);
  });

  test('one readable candidate among failures still produces a decision', async () => {
    // The guard must not swallow a real answer just because its neighbours
    // were unreachable.
    const h = harness({
      urls: ['https://dead.co.uk', 'https://real.co.uk'],
      probes: {
        'https://dead.co.uk': null,
        'https://real.co.uk': probe({
          url: 'https://real.co.uk',
          crnFound: true,
        }),
      },
    });
    const summary = await discoverWebsites(config(), h.deps);

    expect(summary.unreadable).toBe(0);
    expect(summary.foundByNumber).toBe(1);
    expect(h.written[0].outcome.url).toBe('https://real.co.uk');
  });

  test('a genuinely empty result set is still a decided `none`', async () => {
    // No candidates to read is not the same as candidates that would not read:
    // the search answered, and "this company has no findable site" is the
    // answer. It must settle, or the row is retried forever for free.
    const h = harness({ urls: [] });
    const summary = await discoverWebsites(config(), h.deps);

    expect(summary.unreadable).toBe(0);
    expect(summary.foundNothing).toBe(1);
    expect(h.written[0].outcome.url).toBeNull();
  });

  test('a failed bank is retried, and a credit lost anyway is reported', async () => {
    let calls = 0;
    const h = harness({
      bankCandidates: async () => {
        calls += 1;
        throw new Error('PostgresError');
      },
    });
    const summary = await discoverWebsites(config(), h.deps);

    expect(calls).toBe(2);
    expect(summary.creditsLost).toBe(1);
    // Money vanished silently before this: no counter, no line, green tick.
    expect(h.logs.some((l) => l.includes('credit lost'))).toBe(true);
  });

  test('a bank that succeeds on the retry loses nothing', async () => {
    let calls = 0;
    const h = harness({
      bankCandidates: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
      },
    });
    const summary = await discoverWebsites(config(), h.deps);
    expect(summary.creditsLost).toBe(0);
  });
});

describe('what the run is charged for is what it reports', () => {
  test('a failed search is not counted as a credit', async () => {
    // summary.searched is both the budget and the credits_spent figure an
    // operator reconciles against the invoice, so counting uncharged requests
    // overstates spend and eats the budget with queries that never ran.
    const h = harness({
      search: async () => ({ ok: false, reason: 'network' }),
    });
    const summary = await discoverWebsites(config(), h.deps);

    expect(summary.searched).toBe(0);
    expect(summary.errored).toBe(1);
  });

  test('a retried row costs no credit', async () => {
    const h = harness({
      rows: [row({ bankedCandidates: ['https://banked.co.uk'] })],
      search: async () => {
        throw new Error('must not search a banked row');
      },
    });
    const summary = await discoverWebsites(config(), h.deps);

    expect(summary.retried).toBe(1);
    expect(summary.searched).toBe(0);
  });
});

describe('pacing', () => {
  test('every candidate is paced, including the ones that failed to fetch', async () => {
    // `continue` used to skip the delay on the commonest outcome, so five dead
    // hosts became roughly twenty requests back to back — each probe expands
    // to host and scheme variants, each preceded by robots.txt — from a bot
    // that advertises itself by name.
    let sleeps = 0;
    const urls = ['https://a.co.uk', 'https://b.co.uk', 'https://c.co.uk'];
    const h = harness({
      urls,
      probes: Object.fromEntries(urls.map((u) => [u, null])),
      sleep: async () => {
        sleeps += 1;
      },
    });
    await discoverWebsites(config({ delayMs: 400 }), h.deps);

    expect(sleeps).toBe(urls.length);
  });
});
