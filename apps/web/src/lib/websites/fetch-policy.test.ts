import { describe, expect, test } from 'bun:test';

import {
  isAllowedByRobots,
  isPrivateAddress,
  parseRobots,
  urlVariants,
} from './fetch-policy.ts';

describe('urlVariants', () => {
  test('tries https before http and the stored host before its counterpart', () => {
    // 5.3% of stored URLs failed on TLS name mismatch, which is what these
    // variants exist to survive. https first: we prefer to store the secure form.
    expect(urlVariants('https://www.example.co.uk')).toEqual([
      'https://www.example.co.uk',
      'https://example.co.uk',
      'http://www.example.co.uk',
      'http://example.co.uk',
    ]);
  });

  test('adds the www counterpart when the stored host is bare', () => {
    expect(urlVariants('https://example.co.uk')).toEqual([
      'https://example.co.uk',
      'https://www.example.co.uk',
      'http://example.co.uk',
      'http://www.example.co.uk',
    ]);
  });

  test('carries the path, query and port through every variant', () => {
    const variants = urlVariants('https://www.caremark.co.uk:8443/arun?x=1');
    expect(variants).toHaveLength(4);
    for (const v of variants) {
      expect(v).toContain(':8443/arun?x=1');
    }
  });

  test('returns nothing for an unparseable url', () => {
    expect(urlVariants('not a url')).toEqual([]);
  });
});

describe('isPrivateAddress', () => {
  test('refuses loopback, link-local and RFC1918 space', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.169.254',
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  test('refuses carrier-grade NAT space', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('100.127.255.255')).toBe(true);
  });

  test('allows ordinary public addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  test('handles IPv6 loopback and unique-local', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  test('sees through an IPv4-mapped IPv6 address', () => {
    // ::ffff:169.254.169.254 is the cloud metadata endpoint wearing a hat.
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('refuses an empty address rather than defaulting to allowed', () => {
    expect(isPrivateAddress('')).toBe(true);
    expect(isPrivateAddress('   ')).toBe(true);
  });
});

describe('parseRobots', () => {
  const AGENT = 'SponsorSearchBot';

  test('reads the wildcard group', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\n', AGENT);
    expect(rules.disallow).toEqual(['/private']);
  });

  test('reads a group naming us', () => {
    const rules = parseRobots(
      'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: SponsorSearchBot\nDisallow: /s\n',
      AGENT,
    );
    expect(rules.disallow).toEqual(['/s']);
  });

  test('treats consecutive user-agent lines as one group', () => {
    // Both names share a single rule block, so the rule is recorded once.
    const rules = parseRobots(
      'User-agent: *\nUser-agent: SponsorSearchBot\nDisallow: /both\n',
      AGENT,
    );
    expect(rules.disallow).toEqual(['/both']);
  });

  test('a later group for another agent does not leak into ours', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /ours\n\nUser-agent: BadBot\nDisallow: /theirs\n',
      AGENT,
    );
    expect(rules.disallow).toEqual(['/ours']);
  });

  test('ignores groups for other agents', () => {
    const rules = parseRobots('User-agent: BadBot\nDisallow: /\n', AGENT);
    expect(rules.disallow).toEqual([]);
  });

  test('strips comments and tolerates blank lines', () => {
    const rules = parseRobots(
      '# a comment\n\nUser-agent: *   # us\nDisallow: /x  # nope\n',
      AGENT,
    );
    expect(rules.disallow).toEqual(['/x']);
  });

  test('returns empty rules for an empty or junk file', () => {
    expect(parseRobots('', AGENT).disallow).toEqual([]);
    expect(parseRobots('<!doctype html><h1>404</h1>', AGENT).disallow).toEqual(
      [],
    );
  });
});

describe('isAllowedByRobots', () => {
  test('allows when nothing is disallowed', () => {
    expect(isAllowedByRobots({ disallow: [], allow: [] }, '/')).toBe(true);
  });

  test('blocks a disallowed prefix', () => {
    expect(
      isAllowedByRobots({ disallow: ['/admin'], allow: [] }, '/admin/x'),
    ).toBe(false);
    expect(
      isAllowedByRobots({ disallow: ['/admin'], allow: [] }, '/about'),
    ).toBe(true);
  });

  test('blocks everything under a bare slash', () => {
    expect(isAllowedByRobots({ disallow: ['/'], allow: [] }, '/')).toBe(false);
    expect(isAllowedByRobots({ disallow: ['/'], allow: [] }, '/contact')).toBe(
      false,
    );
  });

  test('a longer Allow overrides a broader Disallow', () => {
    const rules = { disallow: ['/'], allow: ['/about'] };
    expect(isAllowedByRobots(rules, '/about')).toBe(true);
    expect(isAllowedByRobots(rules, '/secret')).toBe(false);
  });

  test('Allow wins at equal specificity', () => {
    const rules = { disallow: ['/x'], allow: ['/x'] };
    expect(isAllowedByRobots(rules, '/x')).toBe(true);
  });

  test('handles a trailing wildcard', () => {
    expect(
      isAllowedByRobots({ disallow: ['/tmp*'], allow: [] }, '/tmp/1'),
    ).toBe(false);
  });
});

describe('parseRobots — group precedence', () => {
  const AGENT = 'SponsorSearchBot';

  test('a group naming us wins outright over the wildcard group', () => {
    // The bug: both groups were merged, so the wildcard Allow cancelled the
    // explicit by-name Disallow and we crawled a site that had banned us.
    const rules = parseRobots(
      'User-agent: *\nAllow: /\n\nUser-agent: SponsorSearchBot\nDisallow: /\n',
      AGENT,
    );
    expect(rules.disallow).toEqual(['/']);
    expect(rules.allow).toEqual([]);
    expect(isAllowedByRobots(rules, '/')).toBe(false);
  });

  test('the wildcard group still applies when we are not named', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /admin\n', AGENT);
    expect(rules.disallow).toEqual(['/admin']);
  });

  test('order does not matter: a named group before the wildcard still wins', () => {
    const rules = parseRobots(
      'User-agent: SponsorSearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
      AGENT,
    );
    expect(isAllowedByRobots(rules, '/')).toBe(false);
  });
});

describe('isPrivateAddress — ranges that were slipping through', () => {
  test('refuses IETF protocol assignments and benchmarking space', () => {
    expect(isPrivateAddress('192.0.0.192')).toBe(true);
    expect(isPrivateAddress('198.18.0.1')).toBe(true);
    expect(isPrivateAddress('198.19.255.255')).toBe(true);
  });

  test('refuses multicast, reserved and broadcast', () => {
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
    expect(isPrivateAddress('239.255.255.250')).toBe(true);
    expect(isPrivateAddress('255.255.255.255')).toBe(true);
  });

  test('refuses the hex form of an IPv4-mapped address', () => {
    // ::ffff:a9fe:a9fe is 169.254.169.254 wearing a different hat.
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isPrivateAddress('64:ff9b::a9fe:a9fe')).toBe(true);
  });

  test('still allows ordinary public addresses near those ranges', () => {
    expect(isPrivateAddress('192.0.1.1')).toBe(false);
    expect(isPrivateAddress('198.20.0.1')).toBe(false);
    expect(isPrivateAddress('223.255.255.1')).toBe(false);
    expect(isPrivateAddress('::ffff:0808:0808')).toBe(false);
  });
});

describe('isAllowedByRobots — hostile input', () => {
  test('collapses wildcard runs so the compiled regex cannot blow up', () => {
    // robots.txt comes from arbitrary third-party hosts, and adjacent `.*`
    // groups backtrack exponentially. Runs of `*` mean the same as one.
    const nasty = { disallow: [`/${'*'.repeat(200)}private`], allow: [] };
    const started = Date.now();
    // Collapsed to `/*private`, so it behaves exactly as one wildcard would:
    // a matching path is disallowed, a non-matching one is not, and neither
    // takes measurable time on a 300-character subject.
    expect(isAllowedByRobots(nasty, `/${'a'.repeat(300)}private`)).toBe(false);
    expect(isAllowedByRobots(nasty, `/${'a'.repeat(300)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('a pathologically long directive is bounded, not compiled whole', () => {
    const long = { disallow: [`/${'a*'.repeat(2000)}`], allow: [] };
    const started = Date.now();
    expect(() => isAllowedByRobots(long, '/anything')).not.toThrow();
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('collapsing wildcards does not change what a normal rule matches', () => {
    expect(
      isAllowedByRobots(
        { disallow: ['/**/private'], allow: [] },
        '/uk/private',
      ),
    ).toBe(false);
    expect(
      isAllowedByRobots({ disallow: ['/*/private'], allow: [] }, '/uk/private'),
    ).toBe(false);
    expect(
      isAllowedByRobots({ disallow: ['/*/private'], allow: [] }, '/uk/public'),
    ).toBe(true);
  });
});
