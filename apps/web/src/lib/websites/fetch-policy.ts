/**
 * Pure policy for fetching third-party company websites: which URLs to try,
 * which addresses to refuse, and what robots.txt permits. No I/O, so the rules
 * are testable without a network.
 */

/**
 * The URLs to try before concluding a site is dead, strongest first.
 *
 * Phase 1 measured 5.3% of stored URLs failing with ERR_TLS_CERT_ALTNAME_INVALID,
 * which is the direct cost of normalising every scheme-less registry value to
 * https: plenty of small sites serve https on `www.` only, or not at all. A
 * single attempt would demote those live sites as dead, so the host and scheme
 * counterparts are tried before giving up.
 *
 * Order matters. https before http (we would rather store the secure form), and
 * the stored host before its counterpart (that is the host the registry
 * published).
 */
export function urlVariants(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const host = parsed.hostname;
  const counterpart = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  // Trailing slash stripped to match normaliseWebsiteUrl's canonical form: a
  // variant that succeeds may be stored as the row's new URL, and it must not
  // differ from the stored form by a slash or isSameSite reads it as a change.
  const path = parsed.pathname.replace(/\/+$/, '');
  const tail = `${parsed.port ? `:${parsed.port}` : ''}${path}${parsed.search}`;

  const out: string[] = [];
  for (const scheme of ['https', 'http']) {
    for (const h of [host, counterpart]) {
      const candidate = `${scheme}://${h}${tail}`;
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/** Paths probed for a trading disclosure when the homepage carries none. UK
 *  companies must publish the number somewhere on the site, and on larger sites
 *  it lives on a legal page rather than the front page — which is most of why
 *  globally-branded subsidiaries look unverifiable from the homepage alone. */
export const DISCLOSURE_PATHS = [
  '/contact',
  '/contact-us',
  '/terms',
  '/terms-and-conditions',
  '/legal',
  '/privacy',
  '/about',
  '/about-us',
];

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // IETF protocol assignments — includes 192.0.0.192, which is routable on
  // some clouds.
  /^192\.0\.0\./,
  // Benchmarking range, 198.18.0.0/15.
  /^198\.1[89]\./,
  // Multicast and reserved space, plus the broadcast address.
  /^(22[4-9]|2[3-5]\d)\./,
  /^255\.255\.255\.255$/,
];

/**
 * Whether a resolved IP is one we must never fetch.
 *
 * The URL normaliser already refuses literals and bare hostnames, but a public
 * name can still resolve into private space, deliberately or by accident, and
 * this job runs with database credentials in its environment.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true;
  if (addr.includes(':')) {
    // IPv6: loopback, unspecified, unique-local (fc00::/7) and link-local.
    if (addr === '::1' || addr === '::') return true;
    if (/^f[cd]/.test(addr)) return true;
    if (/^fe[89ab]/.test(addr)) return true;
    // IPv4-mapped and NAT64-embedded addresses carry the v4 rules with them,
    // in either notation. `::ffff:169.254.169.254` was already caught; its hex
    // twin `::ffff:a9fe:a9fe` and the NAT64 form `64:ff9b::a9fe:a9fe` are the
    // same endpoint wearing a different hat, and both were reaching the public
    // branch. Node's lookup usually returns the dotted form, but this is
    // exported policy, so it should not depend on that.
    const dotted = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /(?:::ffff:|^64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
      addr,
    );
    if (hex) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return isPrivateAddress(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    return false;
  }
  return PRIVATE_V4.some((re) => re.test(addr));
}

export type RobotsRules = { disallow: string[]; allow: string[] };

/**
 * Parse the one robots.txt group that applies to us.
 *
 * The most specific matching group wins and every other group is ignored — the
 * wildcard group is a FALLBACK, not something to merge in. Merging them means a
 * site publishing `User-agent: *` / `Allow: /` followed by an explicit
 * `User-agent: SponsorSearchBot` / `Disallow: /` is read as permitting us,
 * because Allow beats Disallow at equal specificity. That is precisely
 * backwards: the operator named us to keep us out, and their only remaining
 * remedy would be an IP block.
 *
 * Deliberately minimal — User-agent, Allow and Disallow only, since that is all
 * isAllowedByRobots consults.
 */
export function parseRobots(body: string, agent: string): RobotsRules {
  const wanted = agent.toLowerCase();
  const named: RobotsRules = { disallow: [], allow: [] };
  const wildcard: RobotsRules = { disallow: [], allow: [] };
  let namedSeen = false;
  // Groups currently being accumulated into; consecutive User-agent lines
  // share one rule block, so a group can target both.
  let targets: RobotsRules[] = [];
  let inGroup = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawField, ...rest] = line.split(':');
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (field === 'user-agent') {
      if (inGroup) {
        targets = [];
        inGroup = false;
      }
      const name = value.toLowerCase();
      if (name === wanted) {
        namedSeen = true;
        if (!targets.includes(named)) targets.push(named);
      } else if (name === '*') {
        if (!targets.includes(wildcard)) targets.push(wildcard);
      }
      continue;
    }
    if (targets.length === 0) continue;
    inGroup = true;
    for (const target of targets) {
      if (field === 'disallow' && value) target.disallow.push(value);
      if (field === 'allow' && value) target.allow.push(value);
    }
  }

  return namedSeen ? named : wildcard;
}

/** Longest-match wins, with Allow beating Disallow at equal length — the
 *  standard precedence, and the one that makes a blanket Disallow plus a
 *  specific Allow behave as the author intended. */
export function isAllowedByRobots(rules: RobotsRules, path: string): boolean {
  const match = (patterns: string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      if (path.startsWith(prefix) && prefix.length > best) best = prefix.length;
    }
    return best;
  };
  const denied = match(rules.disallow);
  if (denied === -1) return true;
  return match(rules.allow) >= denied;
}
