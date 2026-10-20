import { describe, expect, test } from 'bun:test';

import { crowdKey, isDiscoveryAggregator } from './crowded-hosts';

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
});
