// Pure scoring for one client's traffic. No I/O, so the tells that decide "scraper or human" are
// unit-tested rather than re-derived by eye each time.

import type { Bucket } from './observability';

// Static-asset extensions this app actually serves.
const ASSET_EXT =
  /\.(css|js|mjs|woff2?|png|jpe?g|svg|ico|webp|avif|json|txt|xml|map)$/;

// Shared with ban-advice so the SIGNALS line and the blocker cannot contradict each other.
export const MIN_ASSETS = 5;
export const MIN_ASSET_SHARE = 0.005;

/** Whether a client's asset fetches are numerous enough to indicate a real browser. */
export function assetsIndicateBrowser(assets: number, total: number): boolean {
  return assets >= MIN_ASSETS && assets / Math.max(1, total) >= MIN_ASSET_SHARE;
}

/**
 * Whether a client's rendering requests indicate a real browser. Pooled and share-gated: an
 * unconditional `> 0` on any single axis is not evidence.
 *
 * `pages` adds the proportionality test, and it is the one that separates a browser from a
 * headless enumerator. A browser renders EVERY page it loads — the loader alone fires four RPCs
 * per company page here — so rendering scales with pages viewed. Fewer rendering requests than
 * page fetches means most pages produced none at all, which no browser does.
 *
 * Deliberately generous — far below any real session, and well above the enumerator it was
 * calibrated on, so an ordinary visitor cannot fall into it. The calibration is recorded with
 * the operator notes, not here.
 *
 * `pages` defaults to 0, which skips the test: a caller with no page count is no worse off than
 * before it existed, and cannot be made stricter by accident.
 */
export function rendersIndicateBrowser(
  renders: number,
  total: number,
  pages = 0,
): boolean {
  if (renders < MIN_ASSETS) return false;
  if (renders / Math.max(1, total) < MIN_ASSET_SHARE) return false;
  return pages <= 0 || renders >= pages;
}

// Networks people rent servers on. Some large CDNs carry real consumer traffic and are
// deliberately absent; check what a name actually serves before adding it.
const COMPUTE_ASNS = [
  'amazon',
  'amazon.com',
  'aws',
  'google llc',
  'google cloud',
  'microsoft',
  'azure',
  'digitalocean',
  'hetzner',
  'ovh',
  'linode',
  'akamai technologies, inc. (linode)',
  'vultr',
  'choopa',
  'scaleway',
  'contabo',
  'oracle',
  'alibaba',
  'tencent',
  'huawei',
  'leaseweb',
  'fdcservers',
  'egihosting',
  'colocation america',
  'hostpapa',
  'velia',
  'ucloud',
  'logicweb',
  'web2objects',
];

/** Whether an ASN name is a compute provider people rent servers on, rather than one they browse from. */
export function isComputeNetwork(asn: string): boolean {
  const a = asn.toLowerCase();
  return COMPUTE_ASNS.some((n) => a.includes(n));
}

export type PathKind =
  | 'asset'
  | 'beacon'
  | 'rpc'
  | 'tile'
  | 'crawl'
  | 'api'
  | 'page';

/** Classify a request path. `asset`+`beacon` are the sub-resources a raw-HTML fetcher never pulls. */
export function pathKind(path: string): PathKind {
  if (
    path.startsWith('/_vercel/insights') ||
    path.startsWith('/_vercel/speed-insights')
  )
    return 'beacon';
  if (path.startsWith('/_serverFn')) return 'rpc';
  if (path.startsWith('/api/tiles')) return 'tile';
  // Our own API surface. NOT a page: counting /api/revalidate as a page fetch made a
  // server-to-server caller read as HTML enumeration and got ch-stream recommended for a deny.
  if (path.startsWith('/api/')) return 'api';
  // Ahead of the extension test below: a sitemap is .xml but is the opposite of a browser
  // sub-resource, and counting it as one inverts the strongest tell there is.
  if (/^\/(sitemap[\w-]*\.xml|robots\.txt|llms(-full)?\.txt)$/.test(path))
    return 'crawl';
  // Extension-driven, NOT prefix-driven: every asset this app serves is a hashed bundle with one
  // of these extensions, and a prefix test let non-assets under the same path count as browser
  // evidence — which is the evidence that BLOCKS a deny.
  if (ASSET_EXT.test(path)) return 'asset';
  return 'page';
}

export type Mix = Record<PathKind, number> & { total: number };

/** Bucket a path→count list into the seven kinds. */
export function mixOf(paths: [string, number][]): Mix {
  const mix: Mix = {
    asset: 0,
    beacon: 0,
    rpc: 0,
    tile: 0,
    crawl: 0,
    api: 0,
    page: 0,
    total: 0,
  };
  for (const [path, count] of paths) {
    mix[pathKind(path)] += count;
    mix.total += count;
  }
  return mix;
}

/**
 * Fold an RPC count into a route-derived mix. `/__server` carries SSR pages AND every RPC, so
 * the RPCs move out of `page` rather than being double-counted.
 *
 * Takes the BEST FLOOR of two independent estimates. Both under-report: the discovered
 * `/_serverFn` list can be incomplete (fn ids rotate per build, so a fresh deploy's hashes are
 * the youngest and lowest-count entrants in a site-wide grouping that truncates below its cap),
 * and the per-subject path sample truncates for anything walking a catalogue. Undercounting RPCs
 * is the dangerous direction — it is what makes a real SPA session read as a raw-HTML fetcher —
 * so whichever estimate saw more is the one to trust.
 */
export function withRpcs(mix: Mix, discovered: number, fromPaths: number): Mix {
  // Moves the DELTA out of `page`, never overwrites. A route can already classify as rpc on its
  // own (measured in production: 4 such requests on one fingerprint), and replacing the value
  // instead of adding to it silently dropped them from the mix — parts summed to 11,200 against
  // a total of 11,204.
  //
  // Capped at `page`, which is where the rest live: RPCs are a subset of the /__server route, so
  // they can only be moved OUT of that bucket, never conjured beside it. Capping at `total`
  // instead still lets the parts out-sum the whole once assets are counted, and a blocker that
  // reads "5010 rendering requests (496%)" is not a number an operator can act on.
  const target = Math.max(0, mix.rpc, discovered, fromPaths);
  const moved = Math.min(mix.page, target - mix.rpc);
  return { ...mix, rpc: mix.rpc + moved, page: mix.page - moved };
}

/** Every request only a rendering client produces. Pooled because each axis alone is cheap to fake and cheap to miss: assets cache for a year, beacons are ad-blocked, tiles need the map in view. */
export function renderingRequests(mix: Mix): number {
  return mix.asset + mix.beacon + mix.tile + mix.rpc;
}

export type Session = {
  start: string;
  end: string;
  buckets: number;
  total: number;
};
export type Shape = {
  bucketMinutes: number;
  active: number; // buckets with any traffic
  peak: number; // busiest single bucket
  median: number; // median across ACTIVE buckets (idle ones would drag it to 0)
  longestRun: number; // longest unbroken stretch of active buckets
  sessions: Session[]; // runs split by >= GAP_BUCKETS idle buckets
  spanMinutes: number; // first activity to last
  concentration: number; // share of the window's requests inside the busiest session
};

const GAP_BUCKETS = 2; // idle buckets that end a session — 2 keeps a brief pause from splitting one

/**
 * Share of the window a client was ACTIVE in. Active minutes, never first-to-last span: span
 * measures how long a client was around, so any repeat visitor with traffic in both halves of
 * the window scores as level. Shared with adviseBan so the SIGNALS pane and the RECOMMENDATION
 * pane cannot disagree about pacing on the same screen.
 */
export function dutyCycleOf(shape: Shape, windowMinutes: number): number {
  return (shape.active * shape.bucketMinutes) / Math.max(1, windowMinutes);
}

// Busy across most of the window is the automated shape; people are absent from most of theirs.
const LEVEL_DUTY = 0.5;
// A single sitting holding nearly all the traffic — the classic burst-and-idle human shape.
const BURST_CONCENTRATION = 0.9;

/**
 * Session structure from a zero-filled bucket series. Humans burst then idle, so a few dense
 * sessions inside a long quiet window reads human; level traffic across the whole window reads
 * automated. Intensity AND duration both matter — either alone misclassifies.
 */
export function shapeOf(buckets: Bucket[], bucketMinutes: number): Shape {
  const series = [...buckets].sort((a, b) => a.t.localeCompare(b.t));
  const active = series.filter((b) => b.c > 0);
  const counts = active.map((b) => b.c).sort((a, b) => a - b);
  const sessions: Session[] = [];
  let run: Bucket[] = [];
  let idle = 0;

  const flush = () => {
    if (!run.length) return;
    sessions.push({
      start: run[0].t,
      end: run[run.length - 1].t,
      buckets: run.length,
      total: run.reduce((s, b) => s + b.c, 0),
    });
    run = [];
  };
  for (const b of series) {
    if (b.c > 0) {
      idle = 0;
      run.push(b);
    } else if (run.length && ++idle >= GAP_BUCKETS) {
      flush();
    }
  }
  flush();

  let longestRun = 0;
  let cur = 0;
  for (const b of series) {
    cur = b.c > 0 ? cur + 1 : 0;
    if (cur > longestRun) longestRun = cur;
  }

  const total = series.reduce((s, b) => s + b.c, 0);
  const busiest = Math.max(0, ...sessions.map((s) => s.total));
  const spanMinutes =
    active.length > 1
      ? (Date.parse(active[active.length - 1].t) - Date.parse(active[0].t)) /
          60_000 +
        bucketMinutes
      : active.length * bucketMinutes;

  return {
    bucketMinutes,
    active: active.length,
    peak: Math.max(0, ...counts),
    median: counts.length ? counts[Math.floor(counts.length / 2)] : 0,
    longestRun,
    sessions,
    spanMinutes,
    concentration: total ? busiest / total : 0,
  };
}

/** ALPN slot of a JA4a segment (`t13d2013h2` → `h2`). `00` means no ALPN was offered, which no mainstream browser does. */
export function alpnOf(ja4: string): string {
  const head = ja4.split('_')[0] ?? '';
  return head.length >= 10 ? head.slice(8, 10) : '';
}

/**
 * Whether a `requestPath` sample is a FLOOR rather than a count.
 *
 * Two ways it can be: the grouping hit the cap, or its rows do not cover the traffic that could
 * have produced them. The second is the one that bites — the API sheds rows well below the cap.
 *
 * `denied`, NOT denied-plus-challenged. A denied request never reaches routing and cannot appear
 * in the grouping; a CHALLENGED one does appear, carrying the raw path. Counting challenges as
 * absent made the expected coverage zero for a fully-challenged identity, so every sample passed
 * as complete — and the path-diversity tell then divided a true total by a truncated denominator
 * and reported a scraper as "monitoring rather than harvesting".
 */
export function pathsArePartial(
  rows: number,
  sample: number,
  total: number,
  denied: number,
  cap: number,
): boolean {
  return rows >= cap || sample < Math.max(0, total - denied);
}

export type Tell = {
  points: 'human' | 'bot' | 'neutral';
  label: string;
  detail: string;
};

export type SignalInput = {
  total: number;
  /** Distinct request paths seen. Low against high volume means repetition, not exploration. */
  distinctPaths?: number;
  /** True when `distinctPaths` is a floor — the API truncated the sample. */
  distinctPathsPartial?: boolean;
  mix: Mix;
  shape: Shape;
  ja4: [string, number][];
  userAgents: [string, number][];
  asns: [string, number][];
  countries: [string, number][];
  botVerified: [string, number][];
  /** Verified crawler names with counts, so the tell can be narrowed like the blocker is. */
  verifiedBots?: [string, number][];
  /** Verified crawlers we want. Undefined = every verified one still counts, as before the list. */
  allowedBots?: readonly string[];
  windowMinutes: number;
};

/**
 * The discriminating tells, strongest first. Deliberately reports evidence rather than a verdict:
 * every threshold here has a legitimate client somewhere on the wrong side of it, so the operator
 * makes the call. Verified bots are checked first because they invert several of the others.
 */
/**
 * The verified-crawler rows that still count as a legitimacy signal.
 *
 * Falls back to the bare `pass` flag when no names were resolved, so a missing NAME can never
 * strip a real crawler's tell — the same fallback `blockersFor` uses.
 */
function welcomeVerified(input: SignalInput): [string, number][] {
  const named = input.verifiedBots ?? [];
  if (!named.length) return input.botVerified.filter(([v]) => v === 'pass');
  if (!input.allowedBots) return named;
  const want = new Set(input.allowedBots.map((n) => n.toLowerCase()));
  return named.filter(
    ([n]) => n === UNNAMED_VERIFIED || want.has(n.toLowerCase()),
  );
}

export function tellsFor(input: SignalInput): Tell[] {
  const { mix, shape, total } = input;
  const tells: Tell[] = [];
  const pct = (n: number) => `${((n / Math.max(1, total)) * 100).toFixed(1)}%`;

  // Only 'pass' is a verification. A 'fail' row is a client that CLAIMED to be a known crawler
  // and failed Vercel's reverse check — presenting that as "verified" told the operator, in the
  // tool's own words, to discount the strongest tells against a confirmed impersonator.
  // Narrowed like blockersFor. Unnarrowed, this printed "a verified crawler inverts the
  // sub-resource and ALPN tells; do not deny on those alone" directly above a DENY RECOMMENDED
  // whose reasons were exactly those tells — the contradiction the comment below forbids.
  const verified = welcomeVerified(input);
  const failedCheck = input.botVerified.filter(
    ([v]) => v && v.startsWith('fail'),
  );
  if (verified.length)
    tells.push({
      points: 'neutral',
      label: 'verified bot',
      detail: `${verified.map(([v, c]) => `${v} (${c})`).join(', ')} — a verified crawler inverts the sub-resource and ALPN tells; do not deny on those alone`,
    });
  if (failedCheck.length)
    tells.push({
      points: 'bot',
      label: 'failed bot check',
      detail: `${failedCheck.map(([v, c]) => `${v} (${c})`).join(', ')} — it claimed to be a known crawler and Vercel's reverse check refused it, so the UA is a lie`,
    });

  // Every axis, on the same floor blockersFor uses, so SIGNALS and RECOMMENDATION cannot
  // contradict each other on one screen — they did, and the pane that said 'raw-HTML fetcher'
  // sat directly above a green DO NOT DENY.
  const subResource = renderingRequests(mix);
  // mix.page included, or this tell says 'browsers pull these' about the same identity the
  // advisory is refusing as a raw-HTML fetcher — the contradiction the comment above forbids.
  const browsery = rendersIndicateBrowser(subResource, total, mix.page);
  tells.push({
    points: browsery ? 'human' : 'bot',
    label: 'sub-resources',
    detail: browsery
      ? `${subResource} assets/beacons/tiles/RPCs (${pct(subResource)}) — browsers pull these, raw fetchers never do`
      : subResource === 0
        ? `0 rendering requests across ${total} — a raw-HTML fetcher. Weak over short windows (browsers cache), conclusive at volume`
        : `only ${subResource} rendering requests (${pct(subResource)}) across ${total} — too few to be a rendering client`,
  });

  if (mix.beacon > 0)
    tells.push({
      points: 'human',
      label: 'analytics beacons',
      detail: `${mix.beacon} insights/vitals hits — JavaScript actually executed, so a real rendering client`,
    });

  if (mix.crawl > 0)
    tells.push({
      points: mix.page > mix.crawl * 10 ? 'bot' : 'neutral',
      label: 'crawl surface',
      detail:
        `${mix.crawl} sitemap/robots/llms fetches` +
        (mix.page > mix.crawl * 10
          ? ` followed by ${mix.page} page fetches — the sitemap-then-enumerate pattern`
          : ' — normal for a crawler discovering the site'),
    });

  const noAlpn = input.ja4.filter(([d]) => alpnOf(d) === '00');
  if (noAlpn.length)
    tells.push({
      points: 'bot',
      label: 'no ALPN',
      detail: `${noAlpn.length} of ${input.ja4.length} JA4 digests offer no ALPN — necessary but NOT sufficient (Googlebot is also no-ALPN)`,
    });
  else if (input.ja4.length)
    tells.push({
      points: 'human',
      label: 'browser TLS',
      detail: `every JA4 negotiates ALPN (${[...new Set(input.ja4.map(([d]) => alpnOf(d)))].join(', ')}) — a real browser stack`,
    });

  if (input.userAgents.length >= 20) {
    const [topUa] = input.userAgents;
    const med = input.userAgents[Math.floor(input.userAgents.length / 2)];
    const ratio = med?.[1] ? topUa[1] / med[1] : Infinity;
    tells.push({
      points: ratio < 10 ? 'bot' : 'neutral',
      label: 'UA spread',
      detail: `${input.userAgents.length} distinct UAs, top/median ${ratio.toFixed(2)}x — real traffic is Zipf-shaped (100x+); flat means synthetic rotation`,
    });
  } else if (input.userAgents.length)
    tells.push({
      points: input.userAgents.length <= 3 ? 'human' : 'neutral',
      label: 'UA spread',
      detail: `${input.userAgents.length} distinct UA${input.userAgents.length === 1 ? '' : 's'} — coherent for a single client`,
    });

  if (input.asns.length > 1 || input.countries.length > 1)
    tells.push({
      points: 'bot',
      label: 'network spread',
      detail: `${input.asns.length} ASNs / ${input.countries.length} countries on one IP — unusual; check for a shared egress`,
    });

  if (mix.rpc > 0 && mix.page > 0) {
    const ratio = mix.rpc / mix.page;
    tells.push({
      points: ratio > 3 ? 'human' : 'bot',
      label: 'SPA vs SSR',
      detail:
        ratio > 3
          ? `${mix.rpc} RPCs vs ${mix.page} page fetches — driving the app client-side; a scraper fetches page HTML directly, which is far cheaper`
          : `${mix.page} page fetches vs only ${mix.rpc} RPCs — fetching HTML directly rather than running the app`,
    });
  } else if (mix.page > 0 && mix.rpc === 0 && subResource === 0)
    tells.push({
      points: 'bot',
      label: 'SPA vs SSR',
      detail: `${mix.page} page fetches, zero RPCs, zero sub-resources — HTML enumeration`,
    });

  // Where the packets come from, not what the page reports about itself.
  const computeAsns = input.asns.filter(([a]) => isComputeNetwork(a));
  if (computeAsns.length && browsery)
    tells.push({
      points: 'bot',
      label: 'browser on compute',
      detail: `renders like a browser but comes from ${computeAsns.map(([a]) => a).join(', ')} — a hosting network. Headless Chromium is a real browser, so every rendering signal above is genuine and none of them mean "user"`,
    });

  // Repetition vs exploration. A monitor reloads a handful of URLs; a farm walks thousands.
  if (input.distinctPaths && total >= 100) {
    // A truncated sample is a FLOOR, and the two branches can use it differently. The ratio
    // divides by the count, so a floor inflates it — that is how a 177k-request harvester came
    // to be described as "1077x each, monitoring rather than harvesting". The >= 200 test only
    // needs a lower bound, and a floor at or above 200 proves at least 200 distinct paths. So
    // the ratio is gated on a complete sample and the catalogue-walk branch is not, which is
    // what makes it reachable for the enumerators it describes — their samples ALWAYS truncate.
    const partial = input.distinctPathsPartial === true;
    const perPath = total / input.distinctPaths;
    if (!partial && perPath >= 20)
      tells.push({
        points: 'neutral',
        label: 'path diversity',
        detail: `${input.distinctPaths} distinct paths for ${total} requests (${perPath.toFixed(0)}x each) — repetition, so monitoring or preview rendering rather than harvesting`,
      });
    else if (input.distinctPaths >= 200 && mix.page > mix.rpc)
      tells.push({
        points: 'bot',
        label: 'path diversity',
        detail: `${partial ? 'at least ' : ''}${input.distinctPaths} distinct paths, page-heavy — walking the catalogue rather than using it`,
      });
  }

  const dutyCycle = dutyCycleOf(shape, input.windowMinutes);
  const level = dutyCycle > LEVEL_DUTY;
  const burst = shape.concentration >= BURST_CONCENTRATION && !level;
  // Three-way, because "not a textbook burst" is not the same as "automated". Reading anything
  // under a 90% concentration as automated called every repeat visitor a machine, on the same
  // screen as a RECOMMENDATION that had already cleared them.
  tells.push({
    points: level ? 'bot' : burst ? 'human' : 'neutral',
    label: 'session shape',
    detail:
      shape.sessions.length === 0
        ? 'no traffic in the window'
        : `${shape.sessions.length} session${shape.sessions.length === 1 ? '' : 's'}, ` +
          `${(shape.concentration * 100).toFixed(0)}% of requests in the busiest, ` +
          `active across ${(dutyCycle * 100).toFixed(0)}% of the window — ` +
          (level
            ? 'spread level across the window, the automated pattern'
            : burst
              ? 'burst-and-idle, the human pattern'
              : 'a few separate visits, which is neither pattern'),
  });

  return tells;
}

/**
 * Verified crawler names with counts, read from the joined bot key (`verified | name | category`).
 *
 * One derivation for both the subject and its reach: the same rule written twice is the shape
 * that drifts, and here a drift means one gate exempts a crawler the other bans.
 */
/**
 * Name used when Vercel verified a crawler but reported no name.
 *
 * Exempt unconditionally, never matched against FW_ALLOWED_BOTS: it is a placeholder no operator
 * would ever list, so filtering it removed the protection it exists to preserve. The verification
 * is the fact that matters — a blank name field is a gap in the API's reporting, not evidence
 * about the client.
 */
export const UNNAMED_VERIFIED = 'verified';

export function verifiedBotsOf(
  bots: readonly [string, number][],
): [string, number][] {
  const out = new Map<string, number>();
  for (const [key, count] of bots) {
    // Exact, not a prefix. `startsWith('pass')` also accepts a hypothetical `passive`, and the
    // failure direction is the bad one: a non-verified group forwarded as a verified crawler
    // earns the exemption and suppresses the advisory.
    const [status, rawName] = key.split(' | ', 2);
    if (status?.trim() !== 'pass') continue;
    const name = rawName?.trim().toLowerCase() || UNNAMED_VERIFIED;
    out.set(name, (out.get(name) ?? 0) + count);
  }
  return [...out];
}
