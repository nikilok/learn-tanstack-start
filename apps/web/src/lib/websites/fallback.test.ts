import { describe, expect, test } from 'bun:test';

import {
  type FallbackConfig,
  type FallbackDeps,
  type FallbackPage,
  type FallbackPick,
  type FallbackRow,
  fallbackWebsites,
  lostNetwork,
  type PickerAnswer,
  type PickerCandidate,
  type PickerCompany,
  readCandidate,
} from './fallback';

const OWN = 'https://www.quillmerefabrication.co.uk';
const GROUP = 'https://www.quillmere-group.com';
const OTHER = 'https://www.steelworks-direct.co.uk';

/** A fictional engineering company with three banked results and a directory listing. */
const row = (over: Partial<FallbackRow> = {}): FallbackRow => ({
  companyNumber: '09990117',
  companyName: 'QUILLMERE FABRICATION LIMITED',
  sponsorNames: ['Quillmere Fabrication Ltd'],
  registerTowns: ['Wakefield'],
  locality: 'Wakefield',
  postcode: 'WF1 2AB',
  incorporated: '1987-03-14',
  trades: ['Manufacture of metal structures and parts of structures'],
  candidates: [
    `${OTHER}/steel/beams`,
    'https://www.yell.com/biz/quillmere-fabrication',
    `${OWN}/about-us`,
    `${OWN}/contact`,
  ],
  attempts: 0,
  ...over,
});

const config = (over: Partial<FallbackConfig> = {}): FallbackConfig => ({
  maxRows: 10,
  delayMs: 0,
  dryRun: false,
  ...over,
});

/** A homepage long enough to be a real site. */
const page = (title: string, body: string, head = '') =>
  `<html><head><title>${title}</title>${head}</head><body><nav>${'Home About Services Projects Careers Contact '.repeat(40)}</nav><p>${body}</p></body></html>`;

const PAGES: Record<string, string> = {
  [OWN]: page('Quillmere Fabrication | Structural steel', 'Steel since 1987.'),
  [OTHER]: page('Steelworks Direct', 'Beams delivered nationwide.'),
  [GROUP]: page('Quillmere Group', 'Engineering across Europe.'),
};

type Harness = {
  deps: FallbackDeps;
  asked: { company: PickerCompany; candidates: PickerCandidate[] }[];
  written: FallbackPick[];
  settled: string[];
  unloaded: string[];
  fetched: string[];
  logs: string[];
};

function harness(
  answer: PickerAnswer | ((candidates: PickerCandidate[]) => PickerAnswer),
  over: Partial<FallbackDeps> & { rows?: FallbackRow[] } = {},
): Harness {
  const asked: Harness['asked'] = [];
  const written: FallbackPick[] = [];
  const settled: string[] = [];
  const unloaded: string[] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  const serve = async (url: string): Promise<FallbackPage> => {
    fetched.push(url);
    const html = PAGES[url];
    return html ? { ok: true, url, html } : { ok: false };
  };
  const deps: FallbackDeps = {
    selectRows: async () => over.rows ?? [row()],
    crowdedHosts: new Set(),
    fetchSite: serve,
    fetchPage: serve,
    pick: async (company, candidates) => {
      asked.push({ company, candidates });
      return typeof answer === 'function' ? answer(candidates) : answer;
    },
    writePick: async (_row, pick) => {
      written.push(pick);
      return true;
    },
    markSettled: async (settledRow) => {
      settled.push(settledRow.companyNumber);
    },
    markUnloaded: async (unloadedRow) => {
      unloaded.push(unloadedRow.companyNumber);
    },
    sleep: async () => {},
    log: (message) => logs.push(message),
    ...over,
  };
  return { deps, asked, written, settled, unloaded, fetched, logs };
}

const picked = (pick: string): PickerAnswer => ({
  pick,
  reason: 'picked',
  tokens: 2900,
});

describe('fallbackWebsites — which rows are asked', () => {
  test('settles a row whose candidates name no company, unread and unasked', async () => {
    const h = harness(picked(OTHER), {
      rows: [row({ candidates: [`${OTHER}/steel`] })],
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.noneNamed).toBe(1);
    expect(h.fetched).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.settled).toEqual(['09990117']);
  });

  test('leaves out a candidate that does not load and asks with the rest, as the rule was measured', async () => {
    // Most such candidates refuse our fetcher for good (403): holding the row
    // back for them left a quarter of a sealed draw unsettled.
    const h = harness(picked(OTHER), {
      fetchSite: async (url) =>
        url === OWN ? { ok: false } : { ok: true, url, html: PAGES[url] },
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(h.asked[0].candidates.map((c) => c.origin)).toEqual([OTHER]);
    expect(summary).toMatchObject({ asked: 1, homepageFailures: 1 });
  });

  test('keeps a challenged page as a candidate, as the rule was measured', async () => {
    const h = harness(picked(OWN), {
      fetchSite: async (url) => ({
        ok: true,
        url,
        html:
          url === OWN
            ? '<p>Just a moment... Checking your browser before accessing.</p>'
            : PAGES[url],
      }),
    });
    await fallbackWebsites(config(), h.deps);
    expect(h.asked[0].candidates.map((c) => c.origin)).toEqual([OTHER, OWN]);
  });

  test('leaves a row for the next pass when nothing loads, rather than settling it', async () => {
    // A failed load is no answer: settling here would keep the row from the picker for good.
    const h = harness(picked(OWN), { fetchSite: async () => ({ ok: false }) });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.unloaded).toBe(1);
    expect(h.asked).toEqual([]);
    expect(h.settled).toEqual([]);
    // The attempt is counted, so a row that never loads is settled after the last one.
    expect(h.unloaded).toEqual(['09990117']);
  });

  test('a run of retried rows that fail again keeps going, as its network is fine', async () => {
    // Retried rows lead every slice; their failures must not stop the run before fresh rows.
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ companyNumber: String(10000000 + i), attempts: 1 }),
    );
    const h = harness(picked(OWN), {
      rows,
      fetchSite: async () => ({ ok: false }),
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.processed).toBe(40);
    expect(h.unloaded).toHaveLength(40);
  });

  test('stops the run once its homepages stop loading, settling nothing', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ companyNumber: String(10000000 + i) }),
    );
    const h = harness(picked(OWN), {
      rows,
      fetchSite: async () => ({ ok: false }),
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.processed).toBeLessThan(40);
    expect(lostNetwork(summary)).toBe(true);
    expect(h.settled).toEqual([]);
    expect(h.logs.join('\n')).toContain('homepages are not loading');
  });

  test('settles a row with nothing readable, unasked', async () => {
    const parked =
      '<p>This domain is for sale. Buy this domain today from our brokers.</p>';
    const h = harness(picked(OWN), {
      fetchSite: async (url) => ({ ok: true, url, html: parked }),
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.noneReadable).toBe(1);
    expect(h.asked).toEqual([]);
    expect(h.settled).toEqual(['09990117']);
  });

  test('asks with the register facts and the readable candidates, directories left out, in rank order', async () => {
    const h = harness(picked(OWN));
    await fallbackWebsites(config(), h.deps);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].company).toEqual({
      number: '09990117',
      name: 'QUILLMERE FABRICATION LIMITED',
      sponsorNames: ['Quillmere Fabrication Ltd'],
      towns: ['Wakefield'],
      locality: 'Wakefield',
      postcode: 'WF1 2AB',
      incorporated: '1987-03-14',
      trades: ['Manufacture of metal structures and parts of structures'],
    });
    expect(h.asked[0].candidates.map((c) => c.origin)).toEqual([OTHER, OWN]);
    expect(h.asked[0].candidates[1].title).toBe(
      'Quillmere Fabrication | Structural steel',
    );
  });
});

describe('fallbackWebsites — what is kept', () => {
  test('writes the choice as its canonical origin and counts the tokens', async () => {
    const h = harness(picked(OWN));
    const summary = await fallbackWebsites(config(), h.deps);
    expect(h.written).toEqual([{ url: OWN, linkUrl: null }]);
    expect(summary).toMatchObject({ asked: 1, picked: 1, tokens: 2900 });
    // writePick settles the row itself.
    expect(h.settled).toEqual([]);
  });

  test('refuses a named domain whose page is served from a host that names no company', async () => {
    // The domain redirects to another business, whose page is what was read.
    const h = harness(picked(OWN), {
      fetchSite: async (url) => ({
        ok: true,
        url: url === OWN ? `${OTHER}/` : url,
        html: PAGES[url],
      }),
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.notNamed).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.settled).toEqual(['09990117']);
  });

  test('refuses a choice whose domain names no company, and settles the row', async () => {
    const h = harness(picked(OTHER));
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.notNamed).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.settled).toEqual(['09990117']);
  });

  test('refuses the company’s own holding page, and settles the row', async () => {
    const h = harness(picked(OWN), {
      fetchSite: async (url) => ({
        ok: true,
        url,
        html:
          url === OWN
            ? '<p>Quillmere Fabrication Ltd has ceased trading. Thank you to our customers.</p>'
            : PAGES[url],
      }),
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.holdingPage).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.settled).toEqual(['09990117']);
  });

  test('settles a row the picker passes on', async () => {
    const h = harness({ pick: null, reason: 'below_threshold', tokens: 2900 });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.belowThreshold).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.settled).toEqual(['09990117']);
  });

  test('leaves a row for the next pass when the picker cannot answer', async () => {
    const h = harness({ pick: null, reason: 'unavailable', tokens: 0 });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.unavailable).toBe(1);
    expect(h.settled).toEqual([]);
  });

  test('a choice that is not one of the candidates is no answer', async () => {
    const h = harness(picked('https://www.elsewhere.example'));
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.unavailable).toBe(1);
    expect(h.written).toEqual([]);
    expect(h.settled).toEqual([]);
  });

  test('counts a write the database refused, and leaves the row unsettled', async () => {
    const h = harness(picked(OWN), { writePick: async () => false });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary).toMatchObject({ picked: 0, unpersisted: 1 });
    expect(h.settled).toEqual([]);
  });

  test('a dry run decides the same and writes nothing', async () => {
    const h = harness(picked(OWN));
    const summary = await fallbackWebsites(config({ dryRun: true }), h.deps);
    expect(summary.picked).toBe(1);
    expect(h.written).toEqual([]);
    const none = harness(picked(OTHER));
    expect(
      (await fallbackWebsites(config({ dryRun: true }), none.deps)).notNamed,
    ).toBe(1);
    expect(none.settled).toEqual([]);
  });
});

describe('fallbackWebsites — UK sections', () => {
  const groupRow = row({ candidates: [`${GROUP}/en/about`] });
  const withSection = page(
    'Quillmere Group',
    'Engineering across Europe.',
    `<link rel="alternate" hreflang="en-gb" href="${GROUP}/en-gb/">`,
  );

  test('links a group site’s UK section when it loads on the same site', async () => {
    const h = harness(picked(GROUP), {
      rows: [groupRow],
      fetchSite: async (url) => ({ ok: true, url, html: withSection }),
      fetchPage: async (url) => ({ ok: true, url, html: PAGES[GROUP] }),
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(h.written).toEqual([{ url: GROUP, linkUrl: `${GROUP}/en-gb/` }]);
    expect(summary.ukSections).toBe(1);
  });

  test('a section served from the same host written with a trailing dot is the same site', async () => {
    const h = harness(picked(GROUP), {
      rows: [groupRow],
      fetchSite: async (url) => ({ ok: true, url, html: withSection }),
      fetchPage: async () => ({
        ok: true,
        url: 'https://www.quillmere-group.com./en-gb/',
        html: PAGES[GROUP],
      }),
    });
    await fallbackWebsites(config(), h.deps);
    expect(h.written).toEqual([{ url: GROUP, linkUrl: `${GROUP}/en-gb/` }]);
  });

  test('a section that does not load, or lands on another site, is no link', async () => {
    for (const fetchPage of [
      async (): Promise<FallbackPage> => ({ ok: false }),
      async (): Promise<FallbackPage> => ({
        ok: true,
        url: 'https://www.quillmere.co.uk/',
        html: PAGES[GROUP],
      }),
    ]) {
      const h = harness(picked(GROUP), {
        rows: [groupRow],
        fetchSite: async (url) => ({ ok: true, url, html: withSection }),
        fetchPage,
      });
      const summary = await fallbackWebsites(config(), h.deps);
      expect(h.written).toEqual([{ url: GROUP, linkUrl: null }]);
      expect(summary.ukSections).toBe(0);
    }
  });
});

describe('fallbackWebsites — failures', () => {
  test('a row that throws is counted and logged without its company or hosts', async () => {
    const h = harness(picked(OWN), {
      fetchSite: async () => {
        throw new Error(
          'getaddrinfo ENOTFOUND www.quillmerefabrication.co.uk for 09990117',
        );
      },
    });
    const summary = await fallbackWebsites(config(), h.deps);
    expect(summary.errored).toBe(1);
    expect(h.settled).toEqual([]);
    const logged = h.logs.join('\n');
    expect(logged).not.toContain('09990117');
    expect(logged).not.toContain('quillmerefabrication');
  });

  test('a run whose homepages almost all fail has lost its network', () => {
    const base = {
      selected: 0,
      processed: 0,
      noneNamed: 0,
      noneReadable: 0,
      unloaded: 0,
      asked: 0,
      picked: 0,
      ukSections: 0,
      belowThreshold: 0,
      notNamed: 0,
      holdingPage: 0,
      unavailable: 0,
      unpersisted: 0,
      errored: 0,
      tokens: 0,
    };
    const run = (freshFetches: number, freshFailures: number) => ({
      ...base,
      homepageFetches: 200,
      homepageFailures: 200,
      freshFetches,
      freshFailures,
    });
    expect(lostNetwork(run(60, 55))).toBe(true);
    expect(lostNetwork(run(60, 20))).toBe(false);
    // Only first attempts count: retried rows' failures say nothing about the network.
    expect(lostNetwork(run(10, 10))).toBe(false);
    expect(lostNetwork(run(0, 0))).toBe(false);
  });
});

describe('readCandidate', () => {
  test('reads the title and visible text with spaces collapsed', () => {
    expect(
      readCandidate(
        OWN,
        '<title>\n  Quillmere   Fabrication &amp; Sons </title><body><p>Steel\n\n since   1987.</p><script>var x = 1;</script></body>',
      ),
    ).toEqual({
      origin: OWN,
      title: 'Quillmere Fabrication & Sons',
      text: 'Quillmere Fabrication & Sons Steel since 1987.',
    });
  });

  test('keeps at most the first 60,000 characters of text', () => {
    const text = readCandidate(OWN, `<p>${'a'.repeat(70_000)}</p>`).text;
    expect(text).toHaveLength(60_000);
  });
});
