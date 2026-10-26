import { describe, expect, test } from 'bun:test';

import {
  aboutLinks,
  foldWalkPage,
  legalLinks,
  MAX_ABOUT_LINKS,
  MAX_LEGAL_LINKS,
  needsRender,
  readHomepage,
  readWalkPage,
  type WalkPage,
  walkTargets,
} from './disclosure-walk';
import type { CandidateProbe } from './discover';
import { DISCLOSURE_PATHS } from './fetch-policy';

const page = (links: string) => `<html><body><nav>${links}</nav></body></html>`;

describe('legalLinks', () => {
  test('finds the legal pages a homepage links to, privacy first', () => {
    const html = page(
      '<a href="/terms-of-use">Terms of use</a>' +
        '<a href="/contact">Contact</a>' +
        '<a href="/privacy-notice">Privacy notice</a>' +
        '<a href="/about">About us</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk/')).toEqual([
      'https://acme.co.uk/privacy-notice',
      'https://acme.co.uk/terms-of-use',
    ]);
  });

  test('matches the label as well as the target', () => {
    const html = page(
      '<a href="/ln">Legal <b>notice</b></a><a href="/ci">Company information</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk')).toEqual([
      'https://acme.co.uk/ln',
      'https://acme.co.uk/ci',
    ]);
  });

  test('stays on the site, www or not', () => {
    const html = page(
      '<a href="https://acme.co.uk/privacy">Privacy</a>' +
        '<a href="https://host.example/privacy">Privacy (our web host)</a>',
    );
    expect(legalLinks(html, 'https://www.acme.co.uk/')).toEqual([
      'https://acme.co.uk/privacy',
    ]);
  });

  test('resolves against the page that was read, after redirects', () => {
    const html = page('<a href="legal">Legal</a>');
    expect(legalLinks(html, 'https://acme.co.uk/en/')).toEqual([
      'https://acme.co.uk/en/legal',
    ]);
  });

  test('skips links that are not pages', () => {
    const html = page(
      '<a href="mailto:privacy@acme.co.uk">Privacy</a>' +
        '<a href="tel:+441234">Terms</a>' +
        '<a href="javascript:void(0)">Cookie settings</a>' +
        '<a href="#legal">Legal</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk')).toEqual([]);
  });

  test('reads one page once, dropping the fragment and keeping the query', () => {
    const html = page(
      '<a href="/privacy">Privacy</a><a href="/privacy/">Privacy</a>' +
        '<a href="/privacy#top">Privacy</a>' +
        '<a href="/?page_id=3&amp;lang=en">Terms</a>',
    );
    expect(legalLinks(html, 'https://acme.co.uk')).toEqual([
      'https://acme.co.uk/privacy',
      'https://acme.co.uk/?page_id=3&lang=en',
    ]);
  });

  test('an unparseable page URL yields nothing', () => {
    expect(legalLinks(page('<a href="/privacy">Privacy</a>'), 'nope')).toEqual(
      [],
    );
  });
});

describe('aboutLinks', () => {
  test('finds same-site pages about the company or its people, by label or path, in page order', () => {
    const html = page(
      '<a href="/services">Services</a>' +
        '<a href="/our-people">Who we are</a>' +
        '<a href="/x">Meet the team</a>' +
        '<a href="/leadership/">Board</a>' +
        '<a href="/contact">Contact</a>',
    );
    expect(aboutLinks(html, 'https://acme.co.uk/')).toEqual([
      'https://acme.co.uk/our-people',
      'https://acme.co.uk/x',
      'https://acme.co.uk/leadership/',
    ]);
  });

  test('reads an icon link by its aria-label or title', () => {
    const html = page(
      '<a href="/a1" aria-label="About us"><svg></svg></a>' +
        '<a href="/a2" title="Our team"><img src="t.png"></a>',
    );
    expect(aboutLinks(html, 'https://acme.co.uk')).toEqual([
      'https://acme.co.uk/a1',
      'https://acme.co.uk/a2',
    ]);
  });

  test('skips other sites, files, non-pages, the page itself and repeats', () => {
    const html = page(
      '<a href="https://linkedin.com/company/acme/people">People</a>' +
        '<a href="/team-photo.jpg">Team</a>' +
        '<a href="mailto:team@acme.co.uk">Team</a>' +
        '<a href="#about">About</a>' +
        '<a href="/about-acme">About</a>' +
        '<a href="https://www.acme.co.uk/about-acme/">About</a>' +
        '<a href="/">About Acme</a>',
    );
    expect(aboutLinks(html, 'https://acme.co.uk/')).toEqual([
      'https://acme.co.uk/about-acme',
    ]);
  });

  test("reads only a page's first 250 same-site links", () => {
    const links = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `<a href="/p${i}">Page ${i}</a>`,
      ).join('');
    const about = '<a href="/about">About</a>';
    expect(aboutLinks(page(links(250) + about), 'https://acme.co.uk')).toEqual(
      [],
    );
    expect(aboutLinks(page(links(249) + about), 'https://acme.co.uk')).toEqual([
      'https://acme.co.uk/about',
    ]);
  });
});

describe('walkTargets', () => {
  const origin = 'https://acme.co.uk';

  test('reads the homepage links first, then the fixed paths', () => {
    // A registration number only behind a /terms-of-use link: no fixed path
    // list guesses that page.
    expect(walkTargets(origin, [`${origin}/terms-of-use`], 7)).toEqual([
      `${origin}/terms-of-use`,
      `${origin}/privacy`,
      `${origin}/privacy-policy`,
      `${origin}/terms-and-conditions`,
      `${origin}/terms`,
      `${origin}/legal`,
      `${origin}/contact-us`,
      `${origin}/contact`,
    ]);
  });

  test('a link to a fixed path is not read twice', () => {
    const targets = walkTargets(origin, ['https://www.acme.co.uk/privacy/'], 7);
    expect(targets.filter((t) => t.endsWith('/privacy'))).toEqual([
      `${origin}/privacy`,
    ]);
  });

  test('a link to an about page stays out, like the fixed about paths', () => {
    expect(walkTargets(origin, [`${origin}/about-us`], 7)).not.toContain(
      `${origin}/about-us`,
    );
  });

  test('caps the homepage links', () => {
    const links = Array.from({ length: 9 }, (_, i) => `${origin}/legal/${i}`);
    expect(walkTargets(origin, links, 0)).toHaveLength(MAX_LEGAL_LINKS);
  });

  test('seven fixed paths stop before the about pages', () => {
    const targets = walkTargets(origin, [], 7);
    expect(targets).toHaveLength(7);
    expect(targets.some((t) => t.includes('/about'))).toBe(false);
  });

  test('all nine fixed paths, then up to three about links not already listed', () => {
    const about = [
      `${origin}/about-us/`,
      `${origin}/terms-of-use`,
      `${origin}/team`,
      `${origin}/people`,
      `${origin}/leadership`,
      `${origin}/directors`,
    ];
    const targets = walkTargets(origin, [`${origin}/terms-of-use`], 9, about);
    expect(targets).toEqual([
      `${origin}/terms-of-use`,
      ...DISCLOSURE_PATHS.map((path) => `${origin}${path}`),
      `${origin}/team`,
      `${origin}/people`,
      `${origin}/leadership`,
    ]);
    expect(MAX_ABOUT_LINKS).toBe(3);
  });
});

describe('readHomepage', () => {
  const row = {
    companyNumber: '03260168',
    companyName: 'ACME WIDGETS LIMITED',
    sponsorNames: [] as string[],
    postcode: 'SO22 5AZ',
  };
  const address = '<p>Our offices: Unit 4, Winchester SO22 5AZ</p>';

  test("a homepage under the sponsor register's trading name names the company", () => {
    const trading = {
      ...row,
      sponsorNames: ['Acme Widgets Ltd T/A Elmbank Dental'],
    };
    const read = (r: typeof row) =>
      readHomepage(
        r,
        'https://elmbankdental.co.uk',
        'https://elmbankdental.co.uk/',
        address,
        new Set(),
      );
    expect(read(trading)).toMatchObject({
      postcodeFound: true,
      postcodeNamed: true,
    });
    expect(read(row)).toMatchObject({
      postcodeFound: true,
      postcodeNamed: false,
    });
  });

  test('keeps the URL asked for and takes the evidence from the page served', () => {
    expect(
      readHomepage(
        row,
        'https://acmewidgets.co.uk',
        'https://www.acmewidgets.co.uk/',
        address,
        new Set(),
      ),
    ).toMatchObject({
      url: 'https://acmewidgets.co.uk',
      evidenceUrl: 'https://www.acmewidgets.co.uk/',
      postcodeFound: true,
      postcodeNamed: true,
    });
  });

  test('a named domain that redirects to another business: the serving host decides', () => {
    expect(
      readHomepage(
        row,
        'https://acmewidgets.co.uk',
        'https://otherbusiness.co.uk/',
        address,
        new Set(),
      ),
    ).toMatchObject({ postcodeFound: true, postcodeNamed: false });
  });

  test("a brand homepage linking each branch to its what3words page is the company's own", () => {
    const branches = [
      ['Ashbourne DE6 1HA', 'filled.count.soap'],
      ['Rugeley WS15 1RD', 'index.home.raft'],
      ['Market Rasen LN8 3AA', 'grape.lion.tent'],
      ['Driffield YO25 6AB', 'stone.river.coat'],
      ['Malton YO17 7AB', 'mint.pause.lamp'],
    ];
    const html = [
      ...branches.map(
        ([branch, words]) =>
          `<p>${branch}, <a href="https://what3words.com/${words}">https://what3words.com/${words}</a>, open daily from nine to five.</p>`,
      ),
      '<p>Acme Widgets Ltd, Unit 4, Winchester SO22 5AZ. Email: hello@acmewidgets.co.uk</p>',
    ].join('');
    expect(
      readHomepage(
        row,
        'https://www.smile-group.co.uk',
        'https://www.smile-group.co.uk/',
        html,
        new Set(),
      ),
    ).toMatchObject({ postcodeFound: true, postcodeNamed: true });
  });

  test('a homepage served from a directory states nothing', () => {
    const page = readHomepage(
      row,
      'https://acme.co.uk',
      'https://sponsor-list.example/acme',
      '<footer>Acme Widgets Ltd. Company No. 03260168</footer>',
      new Set(['sponsor-list.example']),
    );
    expect(page).toMatchObject({ onAggregator: true, stated: [] });
  });

  test('its number in digit groups, in statutory wording, proves the site', () => {
    expect(
      readHomepage(
        row,
        'https://acmewidgets.co.uk',
        'https://www.acmewidgets.co.uk/',
        '<footer>Acme Widgets Ltd. Company No. 0326 0168</footer>',
        new Set(),
      ),
    ).toMatchObject({
      crnFound: true,
      evidenceUrl: 'https://www.acmewidgets.co.uk/',
    });
  });

  test('reads the page for the two-signal rule, with its about links and any bot challenge', () => {
    const home = readHomepage(
      row,
      'https://acmewidgets.co.uk',
      'https://www.acmewidgets.co.uk/',
      '<nav><a href="/our-team">Our team</a></nav><footer>Acme Widgets Ltd. Company No. 03260168, Winchester</footer>',
      new Set(),
    );
    // Resolved against the page that was served, as the walk reads it.
    expect(home.aboutLinks).toEqual(['https://www.acmewidgets.co.uk/our-team']);
    expect(home.challenged).toBe(false);
    expect(home.pages).toEqual([
      {
        url: 'https://www.acmewidgets.co.uk/',
        text: 'Our team Acme Widgets Ltd. Company No. 03260168, Winchester',
        statedNumbers: ['03260168'],
        postcodes: [],
      },
    ]);
    expect(
      readHomepage(
        row,
        'https://acmewidgets.co.uk',
        'https://acmewidgets.co.uk/',
        '<h1>Just a moment...</h1><p>Checking your browser</p>',
        new Set(),
      ).challenged,
    ).toBe(true);
  });

  test('a phone number with the same digits proves nothing', () => {
    expect(
      readHomepage(
        row,
        'https://acmewidgets.co.uk',
        'https://acmewidgets.co.uk/',
        '<footer>Call us: 020 0326 0168</footer>',
        new Set(),
      ),
    ).toMatchObject({ crnFound: false, evidenceUrl: null });
  });
});

describe('readWalkPage', () => {
  const row = {
    companyNumber: '03260168',
    companyName: 'ACME WIDGETS LIMITED',
    sponsorNames: [] as string[],
    postcode: 'SO22 5AZ',
  };
  const footer =
    '<footer>Acme Widgets Ltd. Company No. 03260168, SO22 5AZ</footer>';
  const address = '<p>Our offices: Unit 4, Winchester SO22 5AZ</p>';

  test("a walked page in the sponsor register's trading name names the company", () => {
    const trading = {
      ...row,
      sponsorNames: ['Acme Widgets Ltd T/A Elmbank Dental'],
    };
    const html = '<p>Elmbank Dental, Unit 4, Winchester SO22 5AZ</p>';
    const url = 'https://bookings.example.co.uk/contact';
    expect(readWalkPage(trading, url, html, new Set())).toMatchObject({
      postcodeFound: true,
      pageNamed: true,
    });
    expect(readWalkPage(row, url, html, new Set())).toMatchObject({
      postcodeFound: true,
      pageNamed: false,
    });
  });

  test('a page served from a host carrying the name names it, whatever it says', () => {
    expect(
      readWalkPage(
        row,
        'https://www.acmewidgets.co.uk/contact',
        address,
        new Set(),
      ),
    ).toMatchObject({ postcodeFound: true, pageNamed: true });
  });

  test('a page without the postcode names nothing, whoever it names', () => {
    expect(
      readWalkPage(
        row,
        'https://www.acmewidgets.co.uk/privacy',
        '<p>Acme Widgets Ltd privacy policy</p>',
        new Set(),
      ),
    ).toMatchObject({ postcodeFound: false, pageNamed: false });
  });

  test('a walked path that redirected off the site is judged where it landed', () => {
    expect(
      readWalkPage(row, 'https://elsewhere.co.uk/privacy', address, new Set()),
    ).toMatchObject({ postcodeFound: true, pageNamed: false });
  });

  test('reads proof and stated numbers off a page on the site', () => {
    const page = readWalkPage(
      row,
      'https://acme.co.uk/privacy',
      footer,
      new Set(),
    );
    expect(page).toMatchObject({
      crnFound: true,
      postcodeFound: true,
      pageNamed: true,
    });
    expect(page?.stated.map((s) => s.companyNumber)).toEqual(['03260168']);
    expect(page?.read).toMatchObject({
      url: 'https://acme.co.uk/privacy',
      statedNumbers: ['03260168'],
      postcodes: ['SO22 5AZ'],
    });
  });

  test('its number in digit groups, in statutory wording, proves the page', () => {
    const page = readWalkPage(
      row,
      'https://acme.co.uk/terms',
      '<footer>Registered in England and Wales No. 0326 0168</footer>',
      new Set(),
    );
    expect(page?.crnFound).toBe(true);
  });

  test('a phone number with the same digits does not', () => {
    const page = readWalkPage(
      row,
      'https://acme.co.uk/contact',
      '<p>Call us: 020 0326 0168</p>',
      new Set(),
    );
    expect(page?.crnFound).toBe(false);
  });

  test("a page showing the postcode under another business's name does not name the company", () => {
    const page = readWalkPage(
      row,
      'https://contractor.co.uk/contact',
      '<p>Our on-site offices: Unit 4, Winchester SO22 5AZ</p>',
      new Set(),
    );
    expect(page).toMatchObject({ postcodeFound: true, pageNamed: false });
  });

  // An exhibitor list: the company named beside its postcode, with its own site, among five others.
  const exhibitors = [
    '<h1>Exhibitors</h1>',
    '<p>Beta Feeds Ltd, Mill Lane, Ashbourne DE6 1HA. W: betafeeds.co.uk</p>',
    '<p>Gamma Hatcheries, Rugeley WS15 1RD. W: gammahatch.eu</p>',
    '<p>Acme Widgets Ltd, Unit 4, Winchester SO22 5AZ. W: acmewidgets.co.uk</p>',
    '<p>Delta Grain, Market Rasen LN8 3AA. W: deltagrain.com</p>',
    '<p>Epsilon Eggs, Driffield YO25 6AB. W: epsiloneggs.co.uk</p>',
    '<p>Zeta Vets, Malton YO17 7AB. W: zetavets.org.uk</p>',
  ].join('');

  test('a listing that gives the company its own site elsewhere does not name it as its own', () => {
    const url = 'https://www.poultry-conference.co.uk/exhibitors';
    expect(readWalkPage(row, url, exhibitors, new Set())).toMatchObject({
      postcodeFound: true,
      pageNamed: false,
    });
    expect(readHomepage(row, url, url, exhibitors, new Set())).toMatchObject({
      postcodeFound: true,
      postcodeNamed: false,
    });
    // The same entries on the company's own domain are its own page.
    expect(
      readWalkPage(
        row,
        'https://acmewidgets.com/stockists',
        exhibitors,
        new Set(),
      ),
    ).toMatchObject({ postcodeFound: true, pageNamed: true });
    // Whatever domain the listing gives the company's site under.
    for (const site of ['acmewidgets.dev', 'acmewidgets.uk.com']) {
      const page = exhibitors.replace('acmewidgets.co.uk', site);
      expect(readHomepage(row, url, url, page, new Set())).toMatchObject({
        postcodeFound: true,
        postcodeNamed: false,
      });
    }
  });

  test('a disclosure path that redirects into a register proves nothing', () => {
    // /company-information -> the Companies House profile prints the number.
    expect(
      readWalkPage(
        row,
        'https://find-and-update.company-information.service.gov.uk/company/03260168',
        footer,
        new Set(),
      ),
    ).toBeNull();
  });

  test('nor does one that lands on a crowded directory', () => {
    expect(
      readWalkPage(
        row,
        'https://sponsor-list.example/company/acme',
        footer,
        new Set(['sponsor-list.example']),
      ),
    ).toBeNull();
  });
});

describe('foldWalkPage', () => {
  const base: CandidateProbe = {
    url: 'https://acme.co.uk',
    evidenceUrl: null,
    crnFound: false,
    postcodeFound: false,
    onAggregator: false,
    parked: false,
  };
  const walked = (over: Partial<WalkPage> = {}): WalkPage => ({
    crnFound: false,
    postcodeFound: false,
    pageNamed: false,
    stated: [],
    read: {
      url: 'https://acme.co.uk/terms',
      text: '',
      statedNumbers: [],
      postcodes: [],
    },
    ...over,
  });

  test('a number on a walked page wins, with that page as the evidence', () => {
    const folded = foldWalkPage(
      { ...base, postcodeFound: true, postcodeNamed: true },
      'https://acme.co.uk/terms',
      walked({ crnFound: true }),
    );
    expect(folded).toMatchObject({
      crnFound: true,
      evidenceUrl: 'https://acme.co.uk/terms',
    });
  });

  test('a postcode counts as named when the page names the company', () => {
    expect(
      foldWalkPage(
        base,
        'https://acme.co.uk/contact',
        walked({ postcodeFound: true, pageNamed: true }),
      ),
    ).toMatchObject({ postcodeFound: true, postcodeNamed: true });
  });

  test("a walked page's own naming decides; the candidate lends it none", () => {
    expect(
      foldWalkPage(
        base,
        'https://elsewhere.co.uk/contact',
        walked({ postcodeFound: true }),
      ),
    ).toMatchObject({ postcodeFound: true, postcodeNamed: false });
  });

  test('a later named postcode replaces an earlier unnamed one', () => {
    const unnamed = foldWalkPage(
      base,
      'https://acme.co.uk/contact',
      walked({ postcodeFound: true }),
    );
    expect(unnamed).toMatchObject({
      postcodeFound: true,
      postcodeNamed: false,
    });
    expect(
      foldWalkPage(
        unnamed,
        'https://acme.co.uk/privacy',
        walked({ postcodeFound: true, pageNamed: true }),
      ),
    ).toMatchObject({
      postcodeNamed: true,
      evidenceUrl: 'https://acme.co.uk/privacy',
    });
  });

  test('the first named postcode is kept', () => {
    const named = {
      ...base,
      postcodeFound: true,
      postcodeNamed: true,
      evidenceUrl: 'https://acme.co.uk/',
    };
    expect(
      foldWalkPage(
        named,
        'https://acme.co.uk/privacy',
        walked({ postcodeFound: true, pageNamed: true }),
      ),
    ).toBe(named);
  });
});

describe('needsRender', () => {
  const row = {
    companyNumber: '09990117',
    companyName: 'QUILLMERE ANALYTICS LIMITED',
    sponsorNames: [] as string[],
    postcode: 'HG1 9ZQ',
  };
  const read = (html: string, crowded = new Set<string>()) =>
    readHomepage(row, 'https://qmx.co.uk', 'https://qmx.co.uk/', html, crowded);
  const words = 'Clinical data for practices across the north. '.repeat(40);

  test('a homepage whose menu its scripts build, or with almost no text, is read again in a browser', () => {
    const shell = read('<div id="root"></div><script src="/app.js"></script>');
    expect(shell).toMatchObject({ siteLinks: 0, thin: true });
    expect(needsRender(shell)).toBe(true);
    const noMenu = read(`<p>${words}</p>`);
    expect(noMenu).toMatchObject({ siteLinks: 0, thin: false });
    expect(needsRender(noMenu)).toBe(true);
  });

  test('so is one whose menu links somewhere but whose page says almost nothing', () => {
    const thin = read(
      '<nav><a href="/services">Services</a></nav><p>Welcome.</p>',
    );
    expect(thin).toMatchObject({ siteLinks: 1, thin: true });
    expect(needsRender(thin)).toBe(true);
  });

  test('a homepage with links and text is not', () => {
    const page = read(
      `<nav><a href="/services">Services</a></nav><p>${words}</p>`,
    );
    expect(page).toMatchObject({ siteLinks: 1, thin: false });
    expect(needsRender(page)).toBe(false);
  });

  test('nor is one the plain read already proved, nor a directory or holding page', () => {
    const shell = '<div id="root"></div>';
    expect(needsRender({ ...read(shell), crnFound: true })).toBe(false);
    expect(
      needsRender({ ...read(shell), postcodeFound: true, postcodeNamed: true }),
    ).toBe(false);
    expect(needsRender({ ...read(shell), parked: true })).toBe(false);
    expect(needsRender(read(shell, new Set(['qmx.co.uk'])))).toBe(false);
  });

  test('nor one that challenged the plain fetch', () => {
    const challenge = read('<title>Just a moment...</title>');
    expect(challenge).toMatchObject({ challenged: true, siteLinks: 0 });
    expect(needsRender(challenge)).toBe(false);
  });

  test('a probe that never counted its links is not flagged by them', () => {
    expect(
      needsRender({
        url: 'https://qmx.co.uk',
        evidenceUrl: null,
        crnFound: false,
        postcodeFound: false,
        onAggregator: false,
        parked: false,
      }),
    ).toBe(false);
  });
});
