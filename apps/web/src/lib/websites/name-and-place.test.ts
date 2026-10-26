import { describe, expect, test } from 'bun:test';

import {
  judgeSite,
  type NameAndPlaceRow,
  PAGE_TEXT_CHARS,
  type PageRead,
  readPage,
} from './name-and-place';
import type { Officer } from './officer-names';

const row: NameAndPlaceRow = {
  companyNumber: '09990117',
  companyName: 'QUILLMERE ANALYTICS LIMITED',
  sponsorNames: [],
  postcode: 'HG1 9ZQ',
  registerTowns: ['Harrogate'],
  locality: 'Harrogate',
};

const idris: Officer = {
  forename: 'IDRIS',
  surname: 'TALLOWMERE',
  current: true,
};

/** A page as the walk would read it. */
const page = (url: string, text: string, stated: string[] = []): PageRead =>
  readPage(
    url,
    text,
    stated.map((companyNumber) => ({ companyNumber, context: '' })),
  );

/** One candidate site of pages, at the first page's origin. */
const site = (...pages: PageRead[]) => ({
  url: new URL(pages[0].url).origin,
  pages,
});

describe('judgeSite: what proves a site', () => {
  test('the exact registered name and a town of its own, proved on the name page', () => {
    const verdict = judgeSite(
      row,
      site(
        page(
          'https://quillmere.co.uk/',
          'Clinical data. Harrogate, North Yorkshire.',
        ),
        page(
          'https://quillmere.co.uk/privacy',
          'This site is run by Quillmere Analytics Ltd.',
        ),
      ),
    );
    expect(verdict).toEqual({
      kind: 'proved',
      evidenceUrl: 'https://quillmere.co.uk/privacy',
    });
  });

  test('a postcode in the registered district stands for the town', () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://quillmere.co.uk/',
            'Quillmere Analytics Ltd, 12 Station Parade, HG1 2AB',
          ),
        ),
      ).kind,
    ).toBe('proved');
  });

  test('an officer named on a site that names the company, with a place', () => {
    const pages = site(
      page('https://quillmere.co.uk/', 'Clinical data from Harrogate.'),
      page(
        'https://quillmere.co.uk/team',
        'Idris Tallowmere, managing director',
      ),
    );
    expect(judgeSite(row, pages)).toEqual({ kind: 'needs_officers' });
    expect(judgeSite(row, pages, [idris])).toEqual({
      kind: 'proved',
      evidenceUrl: 'https://quillmere.co.uk/team',
    });
    expect(judgeSite(row, pages, []).kind).toBe('not_proved');
  });
});

describe("judgeSite: the study's wrong picks stay unproved", () => {
  test('a foreign company with the same name and its own Ltd', () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://quillmere.co.il/',
            'Quillmere Analytics Ltd. Rothschild Blvd, Tel Aviv, Israel.',
          ),
        ),
      ).kind,
    ).toBe('not_proved');
  });

  test("the company's name as the tail of a longer registered name", () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://northgate-qa.ca/',
            'Northgate Quillmere Analytics Ltd, 4 Bay Street, Toronto',
          ),
        ),
      ).kind,
    ).toBe('not_proved');
  });

  test("a white-label portal on a platform's subdomain", () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://quillmere-analytics.portalhost.example/',
            'Quillmere Analytics Ltd client portal. Log in to view your policies.',
          ),
        ),
      ).kind,
    ).toBe('not_proved');
  });

  test("an officer's personal site", () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://idristallowmere.example/',
            'Idris Tallowmere: investor, chair of Quillmere Analytics. Based in Lisbon.',
          ),
        ),
        [idris],
      ).kind,
    ).toBe('not_proved');
  });

  test("a same-named person on a namesake firm's site", () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://quillmere-analytics.com.au/',
            'Quillmere Analytics Pty. Idris Tallowmere, CEO. Sydney NSW 2000.',
          ),
        ),
        [idris],
      ).kind,
    ).toBe('not_proved');
  });
});

describe("judgeSite: the first wave's wrong picks stay unproved", () => {
  test('a business directory listing it by its exact name and town', () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://harrogate-business-finder.example/business-directory',
            'Business directory. Quillmere Analytics Ltd, Station Parade, Harrogate. Hestwick Tiles Ltd, Ripon.',
          ),
        ),
      ).kind,
    ).toBe('not_proved');
  });

  test("a trade association's committee page naming it as a member", () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://data-analysts-association.example/about-us/committees/',
            'Technical committee: Quillmere Analytics Ltd (Harrogate), Varrowby Holdings Limited (Leeds).',
          ),
        ),
      ).kind,
    ).toBe('not_proved');
  });

  test('the homepage of the port it works at, naming it and its director', () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://harrogate-port.example/',
            'Towage is provided by Quillmere Analytics Limited, led by Idris Tallowmere. Harrogate.',
          ),
        ),
        [idris],
      ).kind,
    ).toBe('not_proved');
  });
});

describe('judgeSite: each signal as measured', () => {
  test("the exact name on a page stating another company's number does not count", () => {
    const verdict = judgeSite(
      row,
      site(
        page(
          'https://quillmere.co.uk/',
          'Quillmere Analytics Ltd is a trading name of Varrowby Holdings Limited, company number 08881234. Harrogate.',
          ['08881234'],
        ),
      ),
      [],
    );
    expect(verdict.kind).toBe('not_proved');
  });

  test("the company's own number beside the name is no obstacle", () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://quillmere.co.uk/',
            'Quillmere Analytics Ltd, Harrogate. Company number 09990117.',
            ['09990117'],
          ),
        ),
      ).kind,
    ).toBe('proved');
  });

  test('a town counts as whole words only', () => {
    const ware: NameAndPlaceRow = {
      ...row,
      registerTowns: ['Ware'],
      locality: null,
      postcode: null,
    };
    const software = site(
      page(
        'https://quillmere.co.uk/',
        'Quillmere Analytics Ltd builds software.',
      ),
    );
    expect(judgeSite(ware, software).kind).toBe('not_proved');
    const town = site(
      page(
        'https://quillmere.co.uk/',
        'Quillmere Analytics Ltd, Baldock Street, Ware.',
      ),
    );
    expect(judgeSite(ware, town).kind).toBe('proved');
  });

  test('officers are asked for only when they would decide it', () => {
    // No place: nothing an officer could add.
    expect(
      judgeSite(
        row,
        site(page('https://quillmere.co.uk/', 'Idris Tallowmere')),
      ),
    ).toEqual({ kind: 'not_proved' });
    // A site that never names the company: an officer's name there is a namesake's.
    expect(
      judgeSite(
        row,
        site(page('https://hestwick.co.uk/', 'Idris Tallowmere, Harrogate')),
      ),
    ).toEqual({ kind: 'not_proved' });
  });

  test('the domain alone may name the company for the officer arm', () => {
    expect(
      judgeSite(
        row,
        site(page('https://quillmere.co.uk/', 'Idris Tallowmere, Harrogate')),
        [idris],
      ).kind,
    ).toBe('proved');
  });

  test('the domain names the company even when its pages are served elsewhere', () => {
    expect(
      judgeSite(
        row,
        {
          url: 'https://quillmere.co.uk',
          pages: [
            page('https://qmx-group.co.uk/team', 'Idris Tallowmere, Harrogate'),
          ],
        },
        [idris],
      ).kind,
    ).toBe('proved');
  });

  test('a page naming the company is not enough on a domain that does not', () => {
    expect(
      judgeSite(
        row,
        site(
          page(
            'https://qmx.co.uk/',
            'Quillmere Analytics, Harrogate. Idris Tallowmere, director.',
          ),
        ),
        [idris],
      ).kind,
    ).toBe('not_proved');
  });

  test('a site with no pages read proves nothing', () => {
    expect(
      judgeSite(row, { url: 'https://quillmere.co.uk', pages: [] }).kind,
    ).toBe('not_proved');
  });
});

describe('readPage', () => {
  test('keeps PAGE_TEXT_CHARS of text and reads postcodes off the whole page', () => {
    const filler = 'x '.repeat(PAGE_TEXT_CHARS);
    const read = page('https://quillmere.co.uk/', `${filler} HG1 2AB`);
    expect(read.text).toHaveLength(PAGE_TEXT_CHARS);
    expect(read.postcodes).toEqual(['HG1 2AB']);
  });

  test('collapses whitespace', () => {
    const read = page('https://www.Quillmere.co.uk/about', 'About\n\n  us');
    expect(read.text).toBe('About us');
  });
});
