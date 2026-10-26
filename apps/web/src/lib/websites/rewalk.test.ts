import { describe, expect, test } from 'bun:test';

import type { CandidateProbe, DiscoveryOutcome } from './discover';
import { readPage } from './name-and-place';
import {
  CURRENT_WALK_VERSION,
  type RewalkConfig,
  type RewalkDeps,
  lostNetwork,
  type RewalkRow,
  rewalkWebsites,
} from './rewalk';
import type { StatedOnSite } from './stated-numbers';

const noneRow = (over: Partial<RewalkRow> = {}): RewalkRow => ({
  companyNumber: '03260168',
  companyName: 'ACME WIDGETS LIMITED',
  sponsorNames: [],
  postcode: 'SO22 5AZ',
  registerTowns: [],
  locality: null,
  evidence: 'none',
  url: null,
  candidates: ['https://real.co.uk/contact'],
  walkAttempts: 0,
  ...over,
});

const postcodeRow = (over: Partial<RewalkRow> = {}): RewalkRow => ({
  companyNumber: '03260168',
  companyName: 'ACME WIDGETS LIMITED',
  sponsorNames: [],
  postcode: 'SO22 5AZ',
  registerTowns: [],
  locality: null,
  evidence: 'postcode_on_page',
  url: 'https://stored.co.uk',
  candidates: ['https://higher.co.uk', 'https://stored.co.uk'],
  walkAttempts: 0,
  ...over,
});

const config = (over: Partial<RewalkConfig> = {}): RewalkConfig => ({
  maxRows: 10,
  delayMs: 0,
  dryRun: false,
  ...over,
});

const probe = (over: Partial<CandidateProbe> = {}): CandidateProbe => ({
  url: 'https://real.co.uk',
  evidenceUrl: null,
  crnFound: false,
  postcodeFound: false,
  onAggregator: false,
  parked: false,
  ...over,
});

const stated = (host: string, companyNumber: string): StatedOnSite => ({
  host,
  companyNumber,
  pageUrl: `https://${host}/privacy`,
  context: `Company No. ${companyNumber}`,
});

function harness(
  over: Partial<RewalkDeps> & {
    rows?: RewalkRow[];
    probes?: Record<string, CandidateProbe | null>;
    walks?: Record<string, CandidateProbe>;
  } = {},
) {
  const probed: string[] = [];
  const walked: string[] = [];
  const upgrades: { row: RewalkRow; outcome: DiscoveryOutcome }[] = [];
  const marked: string[] = [];
  const unreadable: string[] = [];
  const recorded: StatedOnSite[][] = [];
  const deps: RewalkDeps = {
    selectRows: async () => over.rows ?? [noneRow()],
    crowdedHosts: new Set(),
    probe: async (_row, url) => {
      probed.push(url);
      if (over.probes && url in over.probes) return over.probes[url];
      return probe({ url });
    },
    walkDisclosure: async (_row, base) => {
      walked.push(base.url);
      return over.walks?.[base.url] ?? base;
    },
    officers: async () => [],
    upgrade: async (row, outcome) => {
      upgrades.push({ row, outcome });
      return true;
    },
    markWalked: async (row) => {
      marked.push(row.companyNumber);
    },
    markUnreadable: async (row) => {
      unreadable.push(row.companyNumber);
    },
    recordStated: async (entries) => {
      recorded.push([...entries]);
    },
    sleep: async () => {},
    log: () => {},
    ...over,
  };
  return { deps, probed, walked, upgrades, marked, unreadable, recorded };
}

describe('rewalkWebsites: none rows', () => {
  test('a number the new walk finds upgrades the row', async () => {
    const h = harness({
      walks: {
        'https://real.co.uk': probe({
          crnFound: true,
          evidenceUrl: 'https://real.co.uk/terms-of-use',
        }),
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.noneToNumber).toBe(1);
    expect(h.upgrades[0].outcome).toMatchObject({
      url: 'https://real.co.uk',
      evidence: 'crn_on_page',
      evidenceUrl: 'https://real.co.uk/terms-of-use',
    });
    expect(h.marked).toEqual([]);
  });

  test('a postcode it finds on a site naming the company upgrades the row to the postcode tier', async () => {
    const h = harness({
      walks: {
        'https://real.co.uk': probe({
          postcodeFound: true,
          postcodeNamed: true,
        }),
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.noneToPostcode).toBe(1);
    expect(h.upgrades[0].outcome.evidence).toBe('postcode_on_page');
  });

  test('a postcode on a site that never names the company leaves the row as it was', async () => {
    const h = harness({
      walks: { 'https://real.co.uk': probe({ postcodeFound: true }) },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.noneToPostcode).toBe(0);
    expect(h.upgrades).toEqual([]);
    expect(h.marked).toEqual(['03260168']);
  });

  test('the probe and the walk are given the company name to look for', async () => {
    const names: string[] = [];
    const h = harness({
      probe: async (row, url) => {
        names.push(row.companyName);
        return probe({ url });
      },
      walkDisclosure: async (row, base) => {
        names.push(row.companyName);
        return base;
      },
    });
    await rewalkWebsites(config(), h.deps);
    expect(names).toEqual(['ACME WIDGETS LIMITED', 'ACME WIDGETS LIMITED']);
  });

  test("the probe and the walk are given the register's names too, on either kind of row", async () => {
    const register = ['Acme Widgets Ltd T/A Elmbank Dental'];
    const given: string[][] = [];
    const h = harness({
      rows: [
        noneRow({ sponsorNames: register }),
        postcodeRow({ companyNumber: '03260169', sponsorNames: register }),
      ],
      probe: async (row, url) => {
        given.push(row.sponsorNames);
        return probe({ url });
      },
      walkDisclosure: async (row, base) => {
        given.push(row.sponsorNames);
        return base;
      },
    });
    await rewalkWebsites(config(), h.deps);
    expect(given.length).toBeGreaterThan(2);
    expect(given.every((names) => names === register)).toBe(true);
  });

  test('read and still nothing: stamped as walked, nothing written', async () => {
    const h = harness();
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unchanged).toBe(1);
    expect(h.upgrades).toEqual([]);
    expect(h.marked).toEqual(['03260168']);
  });

  test('a row it cannot read keeps its answer and only counts the attempt', async () => {
    const h = harness({ probes: { 'https://real.co.uk': null } });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unreadable).toBe(1);
    expect(h.unreadable).toEqual(['03260168']);
    expect(h.upgrades).toEqual([]);
    expect(h.marked).toEqual([]);
  });
});

describe('rewalkWebsites: the two-signal rule', () => {
  test('is walk 3, so a dispatched re-walk reads every none row again', () => {
    expect(CURRENT_WALK_VERSION).toBe(3);
  });

  const company = noneRow({
    companyNumber: '09990117',
    companyName: 'QUILLMERE ANALYTICS LIMITED',
    postcode: 'HG1 9ZQ',
    registerTowns: ['Harrogate'],
    locality: 'Harrogate',
    candidates: ['https://a.co.uk/about'],
  });

  test('a none row the rule proves gains its site, counted apart', async () => {
    const h = harness({
      rows: [company],
      probes: {
        'https://a.co.uk': probe({
          url: 'https://a.co.uk',
          pages: [
            readPage(
              'https://a.co.uk/',
              'Quillmere Analytics Ltd, Station Parade, Harrogate.',
              company,
              [],
            ),
          ],
        }),
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(h.upgrades[0].outcome).toMatchObject({
      url: 'https://a.co.uk',
      evidence: 'name_and_place',
    });
    expect(summary.noneToNameAndPlace).toBe(1);
    expect(summary.noneToPostcode).toBe(0);
  });

  test('officers that cannot be read: a failed ask spends an attempt, a stopped run leaves the row as it was', async () => {
    const unread = async (answer: 'failed' | 'stopped') => {
      const h = harness({
        rows: [{ ...company, candidates: ['https://quillmere.co.uk/'] }],
        probes: {
          'https://quillmere.co.uk': probe({
            url: 'https://quillmere.co.uk',
            pages: [
              readPage(
                'https://quillmere.co.uk/',
                'Quillmere Analytics, Harrogate.',
                company,
                [],
              ),
            ],
          }),
        },
        officers: async () => answer,
      });
      const summary = await rewalkWebsites(config(), h.deps);
      expect(h.marked).toEqual([]);
      expect(summary.officerFailures).toBe(1);
      return {
        unreadable: h.unreadable,
        counted: summary.unreadable,
        lookups: summary.officerLookups,
      };
    };
    expect(await unread('failed')).toEqual({
      unreadable: ['09990117'],
      counted: 1,
      lookups: 1,
    });
    // An outage stops the asking: the row is neither stamped nor charged.
    expect(await unread('stopped')).toEqual({
      unreadable: [],
      counted: 0,
      lookups: 0,
    });
  });

  test('a silent candidate read in a browser: counted, its upgrade too, and what both reads stated recorded', async () => {
    const h = harness({
      rows: [company],
      probes: {
        'https://a.co.uk': probe({
          url: 'https://a.co.uk',
          siteLinks: 0,
          stated: [stated('a.co.uk', '07590616')],
        }),
      },
      render: async (_row, base) => ({
        ...base,
        siteLinks: 3,
        crnFound: true,
        evidenceUrl: 'https://a.co.uk/legal',
        stated: [stated('a.co.uk', '09990117')],
      }),
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(h.upgrades[0].outcome).toMatchObject({
      url: 'https://a.co.uk',
      evidence: 'crn_on_page',
      evidenceUrl: 'https://a.co.uk/legal',
    });
    expect(summary).toMatchObject({
      rendered: 1,
      upgradedByRender: 1,
      noneToNumber: 1,
    });
    expect(h.recorded[0].map((s) => s.companyNumber)).toEqual([
      '07590616',
      '09990117',
    ]);
  });

  test('a render that finds nothing is still counted, and upgrades nothing', async () => {
    const h = harness({
      rows: [company],
      probes: {
        'https://a.co.uk': probe({ url: 'https://a.co.uk', siteLinks: 0 }),
      },
      render: async () => null,
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary).toMatchObject({
      rendered: 1,
      upgradedByRender: 0,
      unchanged: 1,
    });
    expect(h.upgrades).toEqual([]);
  });
});

describe('rewalkWebsites: postcode rows', () => {
  test('walks the stored site only, never the other results', async () => {
    const h = harness({ rows: [postcodeRow()] });
    await rewalkWebsites(config(), h.deps);
    expect(h.probed).toEqual(['https://stored.co.uk']);
    expect(h.walked).toEqual(['https://stored.co.uk']);
  });

  test('a number on the stored site upgrades it in place', async () => {
    const h = harness({
      rows: [postcodeRow()],
      walks: {
        'https://stored.co.uk': probe({
          url: 'https://stored.co.uk',
          crnFound: true,
          evidenceUrl: 'https://stored.co.uk/legal',
        }),
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.postcodeToNumber).toBe(1);
    expect(h.upgrades[0].outcome).toMatchObject({
      url: 'https://stored.co.uk',
      evidence: 'crn_on_page',
      evidenceUrl: 'https://stored.co.uk/legal',
    });
  });

  test('no number: the postcode answer stands, never a demotion', async () => {
    const h = harness({ rows: [postcodeRow()] });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unchanged).toBe(1);
    expect(h.upgrades).toEqual([]);
    expect(h.marked).toEqual(['03260168']);
  });

  test('a stored site that is now a directory is left for the sweep', async () => {
    const h = harness({
      rows: [postcodeRow()],
      probes: {
        'https://stored.co.uk': probe({
          url: 'https://stored.co.uk',
          onAggregator: true,
        }),
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unchanged).toBe(1);
    expect(h.walked).toEqual([]);
    expect(h.upgrades).toEqual([]);
  });

  test('a stored site that will not load keeps its answer', async () => {
    const h = harness({
      rows: [postcodeRow()],
      probes: { 'https://stored.co.uk': null },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unreadable).toBe(1);
    expect(h.unreadable).toEqual(['03260168']);
  });
});

describe('rewalkWebsites: what it records and writes', () => {
  test('records every statutory number the pages stated, once per row', async () => {
    const h = harness({
      probes: {
        'https://real.co.uk': probe({
          stated: [stated('real.co.uk', '03135910')],
        }),
      },
      walks: {
        'https://real.co.uk': probe({
          stated: [
            stated('real.co.uk', '03135910'),
            stated('real.co.uk', '07590616'),
          ],
        }),
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].map((s) => s.companyNumber)).toEqual([
      '03135910',
      '07590616',
    ]);
    expect(summary.statedNumbers).toBe(2);
  });

  test('an upgrade the database refused is counted, not lost silently', async () => {
    const h = harness({
      walks: { 'https://real.co.uk': probe({ crnFound: true }) },
      upgrade: async () => false,
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unpersisted).toBe(1);
    // Refused, so not an upgrade: the run's `upgraded` output sums these.
    expect(summary.noneToNumber).toBe(0);
  });

  test('a dry run writes nothing at all, and still counts', async () => {
    const h = harness({
      rows: [noneRow(), postcodeRow({ companyNumber: 'SC123456' })],
      probes: {
        'https://real.co.uk': probe({
          stated: [stated('real.co.uk', '03135910')],
        }),
      },
      walks: { 'https://real.co.uk': probe({ crnFound: true }) },
    });
    const summary = await rewalkWebsites(config({ dryRun: true }), h.deps);
    expect(summary.noneToNumber).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(h.upgrades).toEqual([]);
    expect(h.marked).toEqual([]);
    expect(h.unreadable).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  test('one row throwing does not stop the run', async () => {
    let calls = 0;
    const h = harness({
      rows: [noneRow(), noneRow({ companyNumber: '00000002' })],
      probe: async (_row, url) => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return probe({ url });
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
    expect(summary.unchanged).toBe(1);
  });

  test('a row that throws spends an attempt, so it cannot lead every slice forever', async () => {
    const h = harness({
      probe: async () => {
        throw new Error('boom');
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
    expect(h.unreadable).toEqual(['03260168']);
  });

  test('a marker that cannot be written after a throw still leaves the row errored', async () => {
    const h = harness({
      probe: async () => {
        throw new Error('boom');
      },
      markUnreadable: async () => {
        throw new Error('database down');
      },
    });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
  });
});

describe('lostNetwork', () => {
  const slice = (walkAttempts: number) =>
    Array.from({ length: 30 }, (_, i) =>
      noneRow({ companyNumber: String(i + 1).padStart(8, '0'), walkAttempts }),
    );

  test('a slice of first attempts that reads almost nothing has lost its network', async () => {
    const h = harness({ rows: slice(0), probe: async () => null });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(lostNetwork(summary)).toBe(true);
  });

  test('dead-site retries at the end of the backlog do not trip it', async () => {
    const h = harness({ rows: slice(1), probe: async () => null });
    const summary = await rewalkWebsites(config(), h.deps);
    expect(summary.unreadable).toBe(30);
    expect(lostNetwork(summary)).toBe(false);
  });
});
