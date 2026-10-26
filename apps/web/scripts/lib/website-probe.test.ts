import { describe, expect, setSystemTime, test } from 'bun:test';

import { readHomepage } from '../../src/lib/websites/disclosure-walk.ts';
import type { DiscoveryRow } from '../../src/lib/websites/discover-sweep.ts';
import type { SiteFetch } from './web-fetch.ts';
import { renderCandidate, walkDisclosure } from './website-probe.ts';

const row: DiscoveryRow = {
  companyNumber: '09990117',
  companyName: 'QUILLMERE ANALYTICS LIMITED',
  sponsorNames: [],
  town: 'Harrogate',
  postcode: 'HG1 9ZQ',
  registerTowns: ['Harrogate'],
  locality: 'Harrogate',
  bankedCandidates: null,
};
const ORIGIN = 'https://www.qmx.co.uk';

/** The homepage probe the walk starts from. */
const home = readHomepage(
  row,
  ORIGIN,
  `${ORIGIN}/`,
  '<nav><a href="/meet-the-team">Meet the team</a></nav><p>Clinical data.</p>',
  new Set(),
);

/** A walk over canned pages, recording what it asked for; every other page 404s. */
async function walk(pages: Record<string, { url?: string; html: string }>) {
  const asked: string[] = [];
  const result = await walkDisclosure(row, home, {
    maxPaths: 9,
    delayMs: 0,
    crowded: new Set(),
    fetch: async (url): Promise<SiteFetch> => {
      asked.push(url);
      const page = pages[url];
      return page
        ? {
            ok: true,
            url: page.url ?? url,
            status: 200,
            html: page.html,
            attempts: 1,
            attemptedUrl: url,
          }
        : {
            ok: false,
            reason: 'http_error',
            status: 404,
            attempts: 1,
            attemptedUrl: url,
          };
    },
  });
  return { asked, result };
}

describe('walkDisclosure', () => {
  test('reads the nine fixed paths, then the homepage about links', async () => {
    const { asked } = await walk({});
    expect(asked).toHaveLength(10);
    expect(asked.at(-1)).toBe('https://www.qmx.co.uk/meet-the-team');
  });

  test('keeps every page it read for the two-signal rule, a redirect to one already read once', async () => {
    const { result } = await walk({
      [`${ORIGIN}/about-us`]: {
        html: '<p>Quillmere Analytics Ltd, Harrogate</p>',
      },
      [`${ORIGIN}/about`]: {
        url: `${ORIGIN}/about-us`,
        html: '<p>Quillmere Analytics Ltd, Harrogate</p>',
      },
    });
    expect(result?.pages?.map((page) => page.url)).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/about-us`,
    ]);
  });

  test('a walk past its deadline reads nothing more', async () => {
    const asked: string[] = [];
    const result = await walkDisclosure(row, home, {
      maxPaths: 9,
      delayMs: 0,
      crowded: new Set(),
      deadline: Date.now() - 1,
      fetch: async (url) => {
        asked.push(url);
        return {
          ok: false,
          reason: 'http_error',
          status: 404,
          attempts: 1,
          attemptedUrl: url,
        };
      },
    });
    expect(asked).toEqual([]);
    expect(result?.pages?.map((page) => page.url)).toEqual([`${ORIGIN}/`]);
  });

  test('stops at the registration number, with what it stated', async () => {
    const { asked, result } = await walk({
      [`${ORIGIN}/privacy`]: {
        html: '<footer>Quillmere Analytics Ltd. Company No. 09990117</footer>',
      },
    });
    expect(asked).toEqual([`${ORIGIN}/privacy`]);
    expect(result).toMatchObject({
      crnFound: true,
      evidenceUrl: `${ORIGIN}/privacy`,
    });
    expect(result?.stated?.map((s) => s.companyNumber)).toEqual(['09990117']);
    expect(result?.pages).toHaveLength(2);
  });
});

describe('renderCandidate', () => {
  /** A browser over canned pages, recording what it rendered and the visits it opened and closed; every other page 404s. */
  const browser = (pages: Record<string, { url?: string; html: string }>) => {
    const asked: string[] = [];
    const visits = { opened: 0, closed: 0 };
    const render = async (url: string): Promise<SiteFetch> => {
      asked.push(url);
      const page = pages[url];
      return page
        ? {
            ok: true,
            url: page.url ?? url,
            status: 200,
            html: page.html,
            attempts: 1,
            attemptedUrl: url,
          }
        : {
            ok: false,
            reason: 'http_error',
            status: 404,
            attempts: 1,
            attemptedUrl: url,
          };
    };
    const visit = () => {
      visits.opened += 1;
      return {
        render,
        close: async () => {
          visits.closed += 1;
        },
      };
    };
    return { asked, visits, visit };
  };
  const options = { maxPaths: 9, delayMs: 0, crowded: new Set<string>() };
  /** The plain read of a homepage whose menu its scripts build. */
  const shell = readHomepage(
    row,
    ORIGIN,
    `${ORIGIN}/`,
    '<div id="root"></div>',
    new Set(),
  );

  test('reads the rendered homepage, then walks the links it shows, every page rendered', async () => {
    const view = browser({
      [ORIGIN]: {
        url: `${ORIGIN}/`,
        html: '<nav><a href="/our-people">Our people</a></nav><p>Clinical data.</p>',
      },
      [`${ORIGIN}/our-people`]: {
        html: '<p>Idris Tallowmere, director. Harrogate.</p>',
      },
    });
    const result = await renderCandidate(row, shell, view, options);
    expect(view.asked[0]).toBe(ORIGIN);
    expect(view.asked).toHaveLength(11);
    expect(view.asked.at(-1)).toBe(`${ORIGIN}/our-people`);
    expect(result?.siteLinks).toBe(1);
    expect(result?.pages?.map((page) => page.url)).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/our-people`,
    ]);
    // One visit for the whole candidate, closed once it is read.
    expect(view.visits).toEqual({ opened: 1, closed: 1 });
  });

  test('a number on the rendered homepage ends it there, as does landing on a directory', async () => {
    const numbered = browser({
      [ORIGIN]: {
        html: '<footer>Quillmere Analytics Ltd. Company No. 09990117</footer>',
      },
    });
    expect(await renderCandidate(row, shell, numbered, options)).toMatchObject({
      url: ORIGIN,
      crnFound: true,
    });
    expect(numbered.asked).toEqual([ORIGIN]);

    const listed = browser({
      [ORIGIN]: {
        url: 'https://listings.example/company/09990117',
        html: '<p>Quillmere Analytics Ltd</p>',
      },
    });
    const result = await renderCandidate(row, shell, listed, {
      ...options,
      crowded: new Set(['listings.example']),
    });
    expect(result?.onAggregator).toBe(true);
    expect(listed.asked).toEqual([ORIGIN]);
  });

  test('a site too slow for its visit keeps what it read', async () => {
    const view = browser({
      [ORIGIN]: {
        url: `${ORIGIN}/`,
        html: '<nav><a href="/our-people">Our people</a></nav><p>Clinical data.</p>',
      },
    });
    const render = view.visit().render;
    const slow = {
      visit: () => ({
        ...view.visit(),
        render: async (url: string) => {
          const page = await render(url);
          // The homepage took the whole visit.
          setSystemTime(new Date(Date.now() + 91_000));
          return page;
        },
      }),
    };
    try {
      const result = await renderCandidate(row, shell, slow, options);
      expect(view.asked).toEqual([ORIGIN]);
      expect(result?.pages?.map((page) => page.url)).toEqual([`${ORIGIN}/`]);
    } finally {
      setSystemTime();
    }
  });

  test('a homepage that will not render is null, its visit closed', async () => {
    const view = browser({});
    expect(await renderCandidate(row, shell, view, options)).toBeNull();
    expect(view.asked).toEqual([ORIGIN]);
    expect(view.visits).toEqual({ opened: 1, closed: 1 });
  });
});
