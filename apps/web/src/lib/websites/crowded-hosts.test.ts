import { describe, expect, test } from 'bun:test';

import {
  crowdKey,
  isDiscoveryAggregator,
  isPlatformPage,
} from './crowded-hosts';

describe('crowdKey', () => {
  test('counts www and bare hosts as one', () => {
    expect(crowdKey('WWW.Example.CO.UK')).toBe('example.co.uk');
    expect(crowdKey('example.co.uk.')).toBe('example.co.uk');
  });

  test('keeps every other subdomain', () => {
    expect(crowdKey('uk.example.com')).toBe('uk.example.com');
  });
});

describe('isDiscoveryAggregator', () => {
  const crowded = new Set(['sponsor-list.example', 'nhs.uk']);

  test('a host search returns for many companies is a directory, listed or not', () => {
    expect(isDiscoveryAggregator('sponsor-list.example', crowded)).toBe(true);
    expect(isDiscoveryAggregator('www.sponsor-list.example', crowded)).toBe(
      true,
    );
  });

  test('a listed host needs no crowding', () => {
    expect(isDiscoveryAggregator('www.endole.co.uk', new Set())).toBe(true);
  });

  test('crowding is per host, so a practice on an NHS subdomain keeps its site', () => {
    // nhs.uk service pages appear for thousands of companies; the surgery's own
    // host does not inherit that count.
    expect(isDiscoveryAggregator('eightlandssurgery.nhs.uk', crowded)).toBe(
      false,
    );
  });

  test('an ordinary company site is untouched', () => {
    expect(isDiscoveryAggregator('www.acme-care.example', crowded)).toBe(false);
  });

  test('Google Sites stays a company site even when crowded', () => {
    // One host serves every Google Sites company, so it crosses the threshold
    // (53 companies on 2026-10-20) while each site is still a company's own.
    const withSites = new Set(['sites.google.com']);
    expect(isDiscoveryAggregator('sites.google.com', withSites)).toBe(false);
  });
});

describe('isPlatformPage', () => {
  test("a business's page on a platform subdomain is never its own site", () => {
    // A charity's fundraising page showed its company number only once its
    // scripts ran; the study labels platform-hosted pages listings.
    expect(isPlatformPage('quillmere-trust.raiselysite.com')).toBe(true);
    expect(isPlatformPage('www.quillmere.wixsite.com')).toBe(true);
    expect(isPlatformPage('quillmere.wheree.com')).toBe(true);
    expect(isDiscoveryAggregator('quillmere.myshopify.com', new Set())).toBe(
      true,
    );
  });

  test("a school's, a practice's or a university's shared domain is not a platform", () => {
    expect(isPlatformPage('quillmere-primary.herts.sch.uk')).toBe(false);
    expect(isPlatformPage('quillmere.scot.nhs.uk')).toBe(false);
    expect(isPlatformPage('chem.ox.ac.uk')).toBe(false);
  });

  test('only the platform itself or a subdomain of it, never a lookalike', () => {
    expect(isPlatformPage('wixsite.com')).toBe(true);
    expect(isPlatformPage('notwixsite.com')).toBe(false);
    expect(isPlatformPage('quillmere.co.uk')).toBe(false);
  });
});
