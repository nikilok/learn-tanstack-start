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
    // IPv4-mapped (::ffff:10.0.0.1) carries the v4 rules with it.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return PRIVATE_V4.some((re) => re.test(addr));
}

export type RobotsRules = { disallow: string[]; allow: string[] };

/**
 * Parse the groups of a robots.txt that apply to us: the `*` group plus any
 * group naming our agent. Deliberately minimal — Allow, Disallow and
 * User-agent only, since that is all the policy below consults.
 */
export function parseRobots(body: string, agent: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };
  const wanted = new Set(['*', agent.toLowerCase()]);
  let applies = false;
  let inGroup = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawField, ...rest] = line.split(':');
    const field = rawField.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (field === 'user-agent') {
      // A new group starts only after a non-user-agent line; consecutive
      // user-agent lines share one group.
      if (inGroup) {
        applies = false;
        inGroup = false;
      }
      if (wanted.has(value.toLowerCase())) applies = true;
      continue;
    }
    if (!applies) continue;
    inGroup = true;
    if (field === 'disallow' && value) rules.disallow.push(value);
    if (field === 'allow' && value) rules.allow.push(value);
  }
  return rules;
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
