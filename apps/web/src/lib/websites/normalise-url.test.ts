import { describe, expect, test } from 'bun:test';

import { isSameSite, normaliseWebsiteUrl } from './normalise-url.ts';

describe('normaliseWebsiteUrl', () => {
  test('assumes https for scheme-less values', () => {
    // All 15,695 CQC provider web addresses arrive with no scheme.
    expect(normaliseWebsiteUrl('www.greensleeves.org.uk')).toBe(
      'https://www.greensleeves.org.uk',
    );
  });

  test('keeps a path, because it identifies the business', () => {
    // 665 CQC rows look like this; collapsing to the origin would point every
    // Caremark franchise at the national site.
    expect(normaliseWebsiteUrl('www.caremark.co.uk/arun')).toBe(
      'https://www.caremark.co.uk/arun',
    );
  });

  test('upgrades http and drops a trailing slash', () => {
    expect(normaliseWebsiteUrl('http://www.reedbusiness.co.uk/')).toBe(
      'https://www.reedbusiness.co.uk',
    );
  });

  test('drops query and fragment but preserves path case', () => {
    expect(
      normaliseWebsiteUrl('HTTPS://WWW.Example.COM/Our-Care?ref=a#top'),
    ).toBe('https://www.example.com/Our-Care');
  });

  test('collapses a bare host with a trailing dot', () => {
    expect(normaliseWebsiteUrl('example.com.')).toBe('https://example.com');
  });

  test('rejects social profiles, which are pages about a company', () => {
    expect(
      normaliseWebsiteUrl('www.facebook.com/yourchoiceresidentials/'),
    ).toBeNull();
    expect(
      normaliseWebsiteUrl('https://uk.linkedin.com/company/acme'),
    ).toBeNull();
  });

  test('rejects social profiles on ANY subdomain or shortener', () => {
    // An exact-host denylist waved these through and stored them at the top
    // tier; mobile-captured registry data routinely carries the m. form.
    expect(normaliseWebsiteUrl('m.facebook.com/AcmeCareHome')).toBeNull();
    expect(normaliseWebsiteUrl('en-gb.facebook.com/AcmeCareHome')).toBeNull();
    expect(normaliseWebsiteUrl('https://fb.com/acme')).toBeNull();
    expect(normaliseWebsiteUrl('https://wa.me/447700900000')).toBeNull();
    expect(normaliseWebsiteUrl('www.youtube.com/@acmecare')).toBeNull();
  });

  test('does not reject a real domain that merely ends in a denied one', () => {
    expect(normaliseWebsiteUrl('www.notfacebook.com')).toBe(
      'https://www.notfacebook.com',
    );
  });

  test('rejects embedded control characters instead of fusing two addresses', () => {
    // The WHATWG parser DELETES tab/CR/LF rather than failing, so this used to
    // normalise to the invented host www.a.co.ukwww.b.co.uk.
    expect(normaliseWebsiteUrl('www.a.co.uk\nwww.b.co.uk')).toBeNull();
    expect(normaliseWebsiteUrl('www.a.co.uk\r\nwww.b.co.uk')).toBeNull();
    expect(normaliseWebsiteUrl('www.a.co.uk\twww.b.co.uk')).toBeNull();
  });

  test('preserves an explicit port, which is part of the destination', () => {
    expect(normaliseWebsiteUrl('https://example.co.uk:8443/x')).toBe(
      'https://example.co.uk:8443/x',
    );
  });

  test('drops a redundant default port', () => {
    expect(normaliseWebsiteUrl('https://example.co.uk:443/x')).toBe(
      'https://example.co.uk/x',
    );
  });

  test('keeps a site hosted on a platform subdomain', () => {
    expect(normaliseWebsiteUrl('www.karonpcc.wix.com/pol-community-care')).toBe(
      'https://www.karonpcc.wix.com/pol-community-care',
    );
  });

  test('rejects non-web schemes', () => {
    // An authority-less scheme survives having https:// prepended, and URL then
    // reads `mailto:care` as userinfo — inventing https://example.co.uk.
    expect(normaliseWebsiteUrl('mailto:care@example.co.uk')).toBeNull();
    expect(normaliseWebsiteUrl('tel:01234567890')).toBeNull();
    expect(normaliseWebsiteUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseWebsiteUrl('data:text/html,<h1>x</h1>')).toBeNull();
  });

  test('rejects userinfo, which disguises where a link goes', () => {
    expect(normaliseWebsiteUrl('https://evil.example/@real.co.uk')).not.toBe(
      'https://real.co.uk',
    );
    expect(normaliseWebsiteUrl('https://user:pw@evil.example')).toBeNull();
    expect(normaliseWebsiteUrl('https://real.co.uk@evil.example')).toBeNull();
  });

  test('rejects hosts that cannot be a published website', () => {
    expect(normaliseWebsiteUrl('localhost')).toBeNull();
    expect(normaliseWebsiteUrl('192.168.1.1')).toBeNull();
    expect(normaliseWebsiteUrl('http://10.0.0.5/admin')).toBeNull();
  });

  test('rejects empty and absent values', () => {
    expect(normaliseWebsiteUrl(null)).toBeNull();
    expect(normaliseWebsiteUrl(undefined)).toBeNull();
    expect(normaliseWebsiteUrl('   ')).toBeNull();
  });

  test('rejects a pathologically long value', () => {
    expect(normaliseWebsiteUrl(`https://a.com/${'x'.repeat(600)}`)).toBeNull();
  });

  test('is idempotent, so re-importing cannot churn the row', () => {
    const once = normaliseWebsiteUrl('www.caremark.co.uk/arun/');
    expect(once).not.toBeNull();
    expect(normaliseWebsiteUrl(once)).toBe(once as string);
  });
});

describe('isSameSite', () => {
  test('ignores a www prefix', () => {
    // Real conflict pair from the first prod dry run: CQC and Wikidata named
    // the same YMCA site and it read as a disagreement.
    expect(
      isSameSite(
        'https://www.liverpoolymca.org.uk',
        'https://liverpoolymca.org.uk',
      ),
    ).toBe(true);
  });

  test('does not conflate different registrable domains', () => {
    // Also from that run — .org.uk and .org really are different sites.
    expect(
      isSameSite('https://www.msichoices.org.uk', 'https://www.msichoices.org'),
    ).toBe(false);
  });

  test('does not conflate different paths on one host', () => {
    expect(
      isSameSite(
        'https://bristol.ac.uk',
        'https://bristol.ac.uk/students-health',
      ),
    ).toBe(false);
  });

  test('treats nulls as equal only to each other', () => {
    expect(isSameSite(null, null)).toBe(true);
    expect(isSameSite(null, 'https://a.com')).toBe(false);
    expect(isSameSite('https://a.com', null)).toBe(false);
  });
});

describe('isSameSite — scheme insensitivity', () => {
  test('an adopted http url is the same site as its https form', () => {
    // The sweep adopts http:// when a site serves no https at all; a
    // scheme-sensitive comparison then read that and the next registry import
    // as two different sites, recording a spurious conflict.
    expect(isSameSite('http://example.co.uk', 'https://example.co.uk')).toBe(
      true,
    );
    expect(
      isSameSite('http://www.example.co.uk', 'https://example.co.uk'),
    ).toBe(true);
  });

  test('it still separates genuinely different sites', () => {
    expect(isSameSite('http://a.co.uk', 'https://b.co.uk')).toBe(false);
    expect(isSameSite('http://a.co.uk/x', 'https://a.co.uk/y')).toBe(false);
  });
});
