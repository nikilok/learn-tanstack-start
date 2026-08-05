// Fixtures are shaped after two measured clients: a real iOS Safari session (one 40-minute burst,
// heavy sub-resources) and the distributed residential-proxy scraper (level volume, zero assets).

import { describe, expect, test } from 'bun:test';

import {
  type PathKind,
  type SignalInput,
  alpnOf,
  assetsIndicateBrowser,
  dutyCycleOf,
  isComputeNetwork,
  mixOf,
  pathKind,
  shapeOf,
  tellsFor,
  withRpcs,
} from './ip-signals';

/** Build a zero-filled 10-minute series with `counts` starting at `offset` buckets in. */
function series(counts: number[], offset: number, length: number) {
  const base = Date.parse('2026-08-03T00:00:00.000Z');
  return Array.from({ length }, (_, i) => ({
    t: new Date(base + i * 600_000).toISOString(),
    c: i >= offset && i - offset < counts.length ? counts[i - offset] : 0,
  }));
}

describe('pathKind', () => {
  test('separates the five kinds', () => {
    expect(pathKind('/_vercel/insights/view')).toBe('beacon');
    expect(pathKind('/_vercel/speed-insights/vitals')).toBe('beacon');
    expect(pathKind('/_serverFn/abc123')).toBe('rpc');
    expect(pathKind('/api/tiles/alidade_smooth/16/32468/20737@2x')).toBe(
      'tile',
    );
    expect(pathKind('/assets/index-C1pPKFbU.js')).toBe('asset');
    expect(pathKind('/fonts/geist-latin.woff2')).toBe('asset');
    expect(pathKind('/favicon.svg')).toBe('asset');
    expect(pathKind('/manifest.json')).toBe('asset');
    expect(pathKind('/')).toBe('page');
    expect(pathKind('/company/cafe-spice-new-ltd')).toBe('page');
  });

  test('sitemaps are crawl surface, not browser sub-resources', () => {
    // .xml/.txt would otherwise read as an asset and invert the sub-resource tell.
    expect(pathKind('/sitemap-1.xml')).toBe('crawl');
    expect(pathKind('/sitemap.xml')).toBe('crawl');
    expect(pathKind('/robots.txt')).toBe('crawl');
    expect(pathKind('/llms.txt')).toBe('crawl');
  });

  test('a slug that merely contains a dot is still a page', () => {
    expect(pathKind('/company/acme-t-a-acme-co-uk')).toBe('page');
  });
});

describe('mixOf', () => {
  test('totals across kinds', () => {
    const mix = mixOf([
      ['/_serverFn/a', 104],
      ['/_vercel/insights/view', 45],
      ['/assets/index.js', 2],
      ['/', 4],
    ]);
    expect(mix).toMatchObject({ rpc: 104, beacon: 45, asset: 2, page: 4 });
    expect(mix.total).toBe(155);
  });
});

describe('alpnOf', () => {
  test('reads the ALPN slot', () => {
    expect(alpnOf('t13dhumnh2_cccccccccccc_dddddddddddd')).toBe('h2');
    expect(alpnOf('t13dpolbh1_999999999999_aaaaaaaaaaaa')).toBe('h1');
    expect(alpnOf('t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb')).toBe('00');
  });

  test('a malformed digest yields no slot rather than throwing', () => {
    expect(alpnOf('')).toBe('');
    expect(alpnOf('short')).toBe('');
  });
});

describe('shapeOf', () => {
  test('one evening burst inside a quiet day reads as a single session', () => {
    const shape = shapeOf(series([246, 105, 177, 135], 120, 144), 10);
    expect(shape.sessions).toHaveLength(1);
    expect(shape.sessions[0].total).toBe(663);
    expect(shape.sessions[0].buckets).toBe(4);
    expect(shape.peak).toBe(246);
    expect(shape.longestRun).toBe(4);
    expect(shape.concentration).toBe(1);
    expect(shape.spanMinutes).toBe(40);
  });

  test('a single idle bucket does not split a session', () => {
    const shape = shapeOf(series([10, 0, 10], 5, 20), 10);
    expect(shape.sessions).toHaveLength(1);
  });

  test('a long gap does split one', () => {
    const shape = shapeOf(series([10, 0, 0, 0, 10], 5, 20), 10);
    expect(shape.sessions).toHaveLength(2);
  });

  test('level traffic spreads concentration across many sessions', () => {
    const shape = shapeOf(series(Array(144).fill(50), 0, 144), 10);
    expect(shape.sessions).toHaveLength(1);
    expect(shape.spanMinutes).toBe(1440);
    expect(shape.median).toBe(50);
  });

  test('an empty series is reported, not crashed on', () => {
    const shape = shapeOf([], 10);
    expect(shape.sessions).toEqual([]);
    expect(shape.peak).toBe(0);
    expect(shape.concentration).toBe(0);
  });
});

/** The real iOS Safari session: one burst, RPC-driven, sub-resources present. */
function humanInput(): SignalInput {
  const paths: [string, number][] = [
    ['/_serverFn/a', 106],
    ['/_serverFn/b', 104],
    ['/_vercel/insights/view', 45],
    ['/assets/index.js', 20],
    ['/api/tiles/x/16/1/1', 87],
    ['/', 4],
  ];
  return {
    total: 366,
    mix: mixOf(paths),
    shape: shapeOf(series([246, 105, 177, 135], 120, 144), 10),
    ja4: [['t13dhumnh2_cccccccccccc_dddddddddddd', 362]],
    userAgents: [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)', 366],
    ],
    asns: [['British Telecommunications Limited', 366]],
    countries: [['GB', 366]],
    botVerified: [],
    windowMinutes: 1440,
  };
}

/** The scraper: level across the window, HTML only, no ALPN. */
function scraperInput(): SignalInput {
  const paths: [string, number][] = [
    ['/company/a', 5000],
    ['/company/b', 5000],
    ['/sitemap-1.xml', 100],
  ];
  return {
    total: 10100,
    mix: mixOf(paths),
    shape: shapeOf(series(Array(144).fill(70), 0, 144), 10),
    ja4: [['t13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb', 10100]],
    userAgents: Array.from(
      { length: 40 },
      (_, i) => [`Mozilla/5.0 Chrome/${100 + i}`, 260 - i] as [string, number],
    ),
    asns: [
      ['ISP A', 6000],
      ['ISP B', 4100],
    ],
    countries: [
      ['DE', 5000],
      ['BR', 5100],
    ],
    botVerified: [],
    windowMinutes: 1440,
  };
}

describe('tellsFor', () => {
  test('the real session reads browser on every strong tell', () => {
    const tells = tellsFor(humanInput());
    const by = (label: string) => tells.find((t) => t.label === label);
    expect(by('sub-resources')?.points).toBe('human');
    expect(by('analytics beacons')?.points).toBe('human');
    expect(by('browser TLS')?.points).toBe('human');
    expect(by('SPA vs SSR')?.points).toBe('human');
    expect(by('session shape')?.points).toBe('human');
    expect(by('network spread')).toBeUndefined();
  });

  test('the scraper reads automated on every strong tell', () => {
    const tells = tellsFor(scraperInput());
    const by = (label: string) => tells.find((t) => t.label === label);
    expect(by('sub-resources')?.points).toBe('bot');
    expect(by('analytics beacons')).toBeUndefined();
    expect(by('no ALPN')?.points).toBe('bot');
    expect(by('UA spread')?.points).toBe('bot');
    expect(by('network spread')?.points).toBe('bot');
    expect(by('session shape')?.points).toBe('bot');
  });

  test('a verified bot is flagged first and never denied on ALPN alone', () => {
    const input = scraperInput();
    // Bare values: byBotVerified comes from a single-dimension query in ip-profile.ts, not the
    // joined botVerified|botName|botCategory row used for display.
    input.botVerified = [['pass', 500]];
    const tells = tellsFor(input);
    expect(tells[0].label).toBe('verified bot');
    expect(tells[0].points).toBe('neutral');
  });

  test('a single request produces tells rather than dividing by zero', () => {
    const tells = tellsFor({
      total: 1,
      mix: mixOf([['/', 1]]),
      shape: shapeOf(series([1], 10, 144), 10),
      ja4: [],
      userAgents: [['WhatsApp/2.22.23.5 i', 1]],
      asns: [['British Telecommunications Limited', 1]],
      countries: [['GB', 1]],
      botVerified: [],
      windowMinutes: 1440,
    });
    expect(tells.length).toBeGreaterThan(0);
    for (const t of tells) expect(t.detail).not.toContain('NaN');
  });
});

describe('tellsFor — review regression', () => {
  test('a FAILED bot check is a bot signal, never presented as verified', () => {
    // Presenting 'fail' as verified told the operator, in the tool's own words, to discount the
    // strongest tells against a client Vercel had explicitly judged to be spoofing.
    const input = scraperInput();
    input.botVerified = [['fail', 900]];
    const tells = tellsFor(input);
    const verified = tells.find((t) => t.label === 'verified bot');
    const failed = tells.find((t) => t.label === 'failed bot check');
    expect(verified).toBeUndefined();
    expect(failed?.points).toBe('bot');
    expect(failed?.detail).toContain('the UA is a lie');
  });

  test("only 'pass' counts as verification", () => {
    const input = scraperInput();
    input.botVerified = [['pass', 500]];
    expect(
      tellsFor(input).find((t) => t.label === 'verified bot')?.points,
    ).toBe('neutral');
  });
});

describe('pathKind — probes are not assets', () => {
  test('a webshell probe under /assets/ is not browser evidence', () => {
    // Measured on t13d201100_...: /assets/images/doc.php and bare /assets/ were its only two
    // "sub-resources", and counting them as such blocked the deny lever on a PHP scanner.
    expect(pathKind('/assets/images/doc.php')).toBe('page');
    expect(pathKind('/assets/')).toBe('page');
    expect(pathKind('/assets/shell.aspx')).toBe('page');
  });

  test('real hashed bundles are still assets wherever they live', () => {
    expect(pathKind('/assets/index-C1pPKFbU.js')).toBe('asset');
    expect(pathKind('/assets/company-KTukeWpj.css')).toBe('asset');
    expect(pathKind('/fonts/geist-latin.woff2')).toBe('asset');
    expect(pathKind('/favicon.svg')).toBe('asset');
  });
});

describe('assetsIndicateBrowser', () => {
  test('a token fetch is not a browser', () => {
    expect(assetsIndicateBrowser(2, 587)).toBe(false);
    expect(assetsIndicateBrowser(1, 10000)).toBe(false);
  });

  test('a real session is', () => {
    expect(assetsIndicateBrowser(42, 663)).toBe(true);
  });

  test('the SIGNALS tell and the blocker agree on the same numbers', () => {
    const input = scraperInput();
    input.mix = mixOf([
      ['/company/a', 585],
      ['/assets/x.js', 2],
    ]);
    input.total = 587;
    const tell = tellsFor(input).find((t) => t.label === 'sub-resources');
    // Same threshold the blocker uses, so one screen cannot say browser while the other acts.
    expect(tell?.points).toBe('bot');
    expect(tell?.detail).toContain('too few');
  });
});

describe('headless browsers', () => {
  test('a compute network is one; a consumer relay is NOT', () => {
    // Private Relay and WARP egress real people through Cloudflare/Akamai/Fastly, and a
    // 1,612-request iPhone Safari session on Cloudflare in the live data is a person.
    expect(isComputeNetwork('Amazon.com, Inc.')).toBe(true);
    expect(isComputeNetwork('DigitalOcean, LLC')).toBe(true);
    expect(isComputeNetwork('Hetzner Online GmbH')).toBe(true);
    expect(isComputeNetwork('Cloudflare, Inc.')).toBe(false);
    expect(isComputeNetwork('British Telecommunications Limited')).toBe(false);
    expect(isComputeNetwork('Hyperoptic Ltd')).toBe(false);
  });

  test('Playwright renders like a browser, so it is caught by WHERE it runs', () => {
    // Every rendering signal is genuine — it drives real Chromium. The discriminator is the ASN.
    const input = humanInput();
    input.asns = [['Amazon.com, Inc.', 366]];
    const tell = tellsFor(input).find((t) => t.label === 'browser on compute');
    expect(tell?.points).toBe('bot');
    expect(tell?.detail).toContain('none of them mean');
  });

  test('the same rendering signals on a consumer ISP raise nothing', () => {
    expect(
      tellsFor(humanInput()).find((t) => t.label === 'browser on compute'),
    ).toBeUndefined();
  });

  test('a raw fetcher on compute is not flagged by this tell — it has its own', () => {
    // The tell is specifically about browser-shaped traffic; a curl loop is caught elsewhere.
    const input = scraperInput();
    input.asns = [['Hetzner Online GmbH', 10100]];
    expect(
      tellsFor(input).find((t) => t.label === 'browser on compute'),
    ).toBeUndefined();
  });

  test('few paths at volume reads as monitoring, not harvesting', () => {
    // Measured: 572 requests over 2 paths (571x /sw.js) from Microsoft.
    const input = humanInput();
    input.total = 572;
    input.distinctPaths = 2;
    const tell = tellsFor(input).find((t) => t.label === 'path diversity');
    expect(tell?.points).toBe('neutral');
    expect(tell?.detail).toContain('monitoring');
  });

  test('many paths, page-heavy, reads as walking the catalogue', () => {
    const input = scraperInput();
    input.distinctPaths = 4000;
    const tell = tellsFor(input).find((t) => t.label === 'path diversity');
    expect(tell?.points).toBe('bot');
    expect(tell?.detail).toContain('walking the catalogue');
  });
});

// Regression: tellsFor measured the duty cycle from spanMinutes (first-to-last activity) while
// adviseBan measured it from active minutes. A repeat visitor therefore got "spread level across
// the window, the automated pattern" in SIGNALS directly above a RECOMMENDATION that had already
// cleared them — the two-panes-disagree failure this codebase keeps having to close.
describe('dutyCycleOf', () => {
  const shape = (activeBuckets: number[], length = 144) =>
    shapeOf(
      series([], 0, length).map((b, i) => ({
        ...b,
        c: activeBuckets.includes(i) ? 30 : 0,
      })),
      10,
    );

  test('measures how much of the window was active, not how long the client was around', () => {
    // Three visits spread across a day: 9 active 10-minute buckets in 1440 minutes.
    const s = shape([48, 49, 50, 78, 79, 80, 126, 127, 128]);
    expect(dutyCycleOf(s, 1440)).toBeCloseTo(90 / 1440, 5);
    // The span between the first and last visit is ~810 minutes — 9x the real figure.
    expect(s.spanMinutes).toBeGreaterThan(700);
  });

  test('a genuinely level client still reads as level', () => {
    const s = shape(Array.from({ length: 144 }, (_, i) => i));
    expect(dutyCycleOf(s, 1440)).toBe(1);
  });

  test('never divides by zero on an empty window', () => {
    expect(dutyCycleOf(shape([]), 0)).toBe(0);
  });

  test('a flat scraper still reads automated', () => {
    const input: SignalInput = {
      ...scraperInput(),
      shape: shape(Array.from({ length: 144 }, (_, i) => i)),
    };
    const t = tellsFor(input).find((x) => x.label === 'session shape');
    expect(t?.points).toBe('bot');
    expect(t?.detail).toContain('automated pattern');
  });

  test('one long burst still reads human', () => {
    const input: SignalInput = {
      ...humanInput(),
      shape: shape([60, 61, 62, 63]),
      windowMinutes: 1440,
    };
    const t = tellsFor(input).find((x) => x.label === 'session shape');
    expect(t?.points).toBe('human');
    expect(t?.detail).toContain('burst-and-idle');
  });

  test('a repeat visitor is not called automated by the session-shape tell', () => {
    const input: SignalInput = {
      ...humanInput(),
      total: 270,
      shape: shape([48, 49, 50, 78, 79, 80, 126, 127, 128]),
      windowMinutes: 1440,
    };
    const shapeTell = tellsFor(input).find((t) => t.label === 'session shape');
    expect(shapeTell?.detail).not.toContain('automated pattern');
    expect(shapeTell?.points).toBe('neutral');
    expect(shapeTell?.detail).toContain('6% of the window');
  });
});

// The ban decision's mix is built from the `route` dimension, not `requestPath`: measured on a
// live 177k-request scraper the path grouping covered 0.5% of its traffic, while routes covered
// all of it in 8 rows. That only works if pathKind reads route strings the same way, so these
// are the exact strings the API returns.
describe('pathKind on route strings', () => {
  test.each([
    ['/api/tiles/[theme]/[z]/[x]/[y]', 'tile'],
    ['/_vercel/insights/view', 'beacon'],
    ['/_vercel/speed-insights/vitals', 'beacon'],
    ['/assets/index-C1pPKFbU.js', 'asset'],
    ['/assets/index-DkIQfbF5.css', 'asset'],
    ['/fonts/geist-latin.woff2', 'asset'],
    ['/favicon.svg', 'asset'],
    ['/icon-192.png', 'asset'],
    ['/robots.txt', 'crawl'],
    ['/api/revalidate', 'api'],
  ] as [string, PathKind][])('%s is %s', (route, kind) => {
    expect(pathKind(route)).toBe(kind);
  });

  test('/__server is a page — it is SSR plus RPCs, and the RPCs are moved out by an exact count', () => {
    // If this ever became 'asset' or 'beacon' the whole catalogue walk would read as browser
    // evidence and no enumerator could ever be denied.
    expect(pathKind('/__server')).toBe('page');
  });
});

// The discovered /_serverFn list can be incomplete — fn ids rotate per build, so a fresh
// deploy's hashes are the youngest, lowest-count entrants in a site-wide grouping that truncates
// below its cap. Undercounting RPCs is what turns a real SPA session into a "raw-HTML fetcher",
// so two independent floors are kept and the larger wins.
describe('withRpcs', () => {
  const routeMix = () =>
    mixOf([
      ['/__server', 1000],
      ['/assets/x.js', 10],
    ]);

  test('moves RPCs out of page rather than double-counting them', () => {
    const m = withRpcs(routeMix(), 300, 0);
    expect(m.rpc).toBe(300);
    expect(m.page).toBe(700);
    expect(m.rpc + m.page).toBe(1000); // /__server is SSR pages AND RPCs
  });

  test('the path sample wins when the discovered list came back short', () => {
    // The failure this exists for: a deploy an hour ago, so the current build's hashes are
    // missing from the list and the exact count reads 40 when the client really made 300.
    const m = withRpcs(routeMix(), 40, 300);
    expect(m.rpc).toBe(300);
    expect(m.page).toBe(700);
  });

  test('the discovered list wins when the path sample was truncated', () => {
    const m = withRpcs(routeMix(), 300, 0);
    expect(m.rpc).toBe(300);
  });

  test('both zero leaves the mix alone — a genuine raw-HTML fetcher', () => {
    const m = withRpcs(routeMix(), 0, 0);
    expect(m.rpc).toBe(0);
    expect(m.page).toBe(1000);
  });

  test('an overshooting count cannot break the Mix invariant', () => {
    // page never goes negative, AND rpc never exceeds total — otherwise renderingRequests can
    // report more requests than the client made and the blocker prints a share above 100%.
    const m = withRpcs(routeMix(), 5000, 0);
    expect(m.page).toBe(0);
    expect(m.rpc).toBeLessThanOrEqual(m.total);
    expect(m.asset + m.beacon + m.tile + m.rpc + m.page).toBe(m.total);
  });

  test('routes that already classify as rpc are kept, not overwritten', () => {
    // Regression measured in production: 4 requests were classified rpc by the route grouping,
    // and replacing the value instead of adding the delta dropped them from the mix entirely.
    const m = withRpcs(
      mixOf([
        ['/__server', 1000],
        ['/_serverFn/abc', 4],
      ]),
      300,
      0,
    );
    expect(m.rpc).toBe(300);
    expect(m.asset + m.beacon + m.tile + m.rpc + m.page + m.crawl + m.api).toBe(
      m.total,
    );
  });

  test('an already-classified count above both estimates survives', () => {
    const m = withRpcs(
      mixOf([
        ['/__server', 100],
        ['/_serverFn/abc', 90],
      ]),
      5,
      5,
    );
    expect(m.rpc).toBe(90);
    expect(m.page).toBe(100);
  });

  test('a normal count is untouched by the cap', () => {
    // The cap must only bind in the degenerate case, never shave a real RPC count.
    expect(withRpcs(routeMix(), 300, 0).rpc).toBe(300);
    // /__server is 1000 of the 1010, so that is the ceiling — the 10 assets were never RPCs.
    expect(withRpcs(routeMix(), 1000, 0).rpc).toBe(1000);
  });

  test('leaves the other rendering axes untouched', () => {
    const m = withRpcs(routeMix(), 300, 0);
    expect(m.asset).toBe(10);
    expect(m.total).toBe(1010);
  });
});

// The catalogue-walk branch was structurally dead: it needs >=200 distinct paths, but
// distinctPaths was suppressed whenever the sample truncated — and a >=200-path subject ALWAYS
// truncates. It reads plausibly and could never run, the same shape as the pacing axis.
describe('path diversity — floor vs ratio', () => {
  const walker = (over: Partial<SignalInput> = {}): SignalInput => ({
    ...scraperInput(),
    total: 9000,
    mix: mixOf([['/company/a', 9000]]),
    distinctPaths: 480,
    distinctPathsPartial: true,
    ...over,
  });
  const diversity = (i: SignalInput) =>
    tellsFor(i).find((t) => t.label === 'path diversity');

  test('a truncated count still reaches the catalogue-walk branch', () => {
    const t = diversity(walker());
    expect(t?.points).toBe('bot');
    expect(t?.detail).toContain('walking the catalogue');
    // Marked as the floor it is, never stated as an exact count.
    expect(t?.detail).toContain('at least 480');
  });

  test('a truncated count never drives the RATIO branch', () => {
    // Dividing 9000 by a floor of 480 gives 19x and would read as "repetition, monitoring
    // rather than harvesting" for an actual harvester — the line this pane printed for a
    // 177k-request scraper.
    const t = diversity(walker({ total: 9000, distinctPaths: 400 }));
    expect(t?.detail).not.toContain('monitoring');
  });

  test('a complete sample still gets the ratio branch', () => {
    const t = diversity(
      walker({ distinctPaths: 3, distinctPathsPartial: false, total: 9000 }),
    );
    expect(t?.points).toBe('neutral');
    expect(t?.detail).toContain('monitoring');
  });

  test('a complete count that is neither repetitive nor a walk says nothing', () => {
    // 150 paths under 200, and 6.7x each is well under the repetition line — normal browsing.
    expect(
      diversity(
        walker({
          distinctPaths: 150,
          distinctPathsPartial: false,
          total: 1000,
        }),
      ),
    ).toBeUndefined();
  });
});
