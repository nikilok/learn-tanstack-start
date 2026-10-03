import { describe, expect, test } from 'bun:test';

import { type Mapping, profileSource } from './profile-source';
import type { HmrcLocation } from './resolve-sponsor';

/** Fake reads for one organisation, recording each read in order. */
function readsFor(state: {
  mapping?: Mapping;
  cached?: { companyName: string };
  location?: HmrcLocation;
}) {
  const made: string[] = [];
  return {
    made,
    reads: {
      mapping: async () => {
        made.push('mapping');
        return state.mapping;
      },
      cachedProfile: async (companyNumber: string) => {
        made.push(`cachedProfile ${companyNumber}`);
        return state.cached;
      },
      registerRow: async () => {
        made.push('registerRow');
        return state.location;
      },
    },
  };
}

const verifiedAt = new Date('2026-09-01T00:00:00Z');
const mapped = { companyNumber: '99999999', verifiedAt };
const stub = { companyNumber: null, verifiedAt: null };
const cached = { companyName: 'ACME LIMITED' };
const onRegister = { townCity: 'Leeds', county: 'West Yorkshire' };

describe('profileSource: Companies House is reached only from the register', () => {
  test('a sponsor that has left the register is not fetched again', async () => {
    // The ingest swaps the register wholesale and never deletes mappings.
    const { made, reads } = readsFor({ mapping: mapped });
    expect(await profileSource(reads)).toEqual({ kind: 'none' });
    expect(made).toEqual(['mapping', 'cachedProfile 99999999', 'registerRow']);
  });

  test('a stub left by a sponsor that has left the register is not resolved', async () => {
    const { reads } = readsFor({ mapping: stub });
    expect(await profileSource(reads)).toEqual({ kind: 'none' });
  });

  test('a name with no mapping and no register row is not resolved', async () => {
    const { made, reads } = readsFor({});
    expect(await profileSource(reads)).toEqual({ kind: 'none' });
    expect(made).toEqual(['mapping', 'registerRow']);
  });

  test('a register row with no town or county is still on the register', async () => {
    // Most register rows have no county; locality is optional, membership is not.
    const noLocality = { townCity: null, county: null };
    const unmapped = readsFor({ location: noLocality });
    expect(await profileSource(unmapped.reads)).toEqual({
      kind: 'resolve',
      location: noLocality,
    });
    const uncached = readsFor({ mapping: mapped, location: noLocality });
    expect(await profileSource(uncached.reads)).toEqual({
      kind: 'fetch',
      companyNumber: '99999999',
    });
  });
});

describe('profileSource: routing for organisations on the register', () => {
  test('a cached profile is served without reading the register', async () => {
    const { made, reads } = readsFor({
      mapping: mapped,
      cached,
      location: onRegister,
    });
    expect(await profileSource(reads)).toEqual({ kind: 'cached', row: cached });
    expect(made).toEqual(['mapping', 'cachedProfile 99999999']);
  });

  test('a mapping to no Companies House entity answers from the mapping alone', async () => {
    // Public bodies and verified no-matches.
    const { made, reads } = readsFor({
      mapping: { ...stub, verifiedAt },
      location: onRegister,
    });
    expect(await profileSource(reads)).toEqual({ kind: 'none' });
    expect(made).toEqual(['mapping']);
  });

  test('a mapped company whose profile is not cached is fetched', async () => {
    const { reads } = readsFor({ mapping: mapped, location: onRegister });
    expect(await profileSource(reads)).toEqual({
      kind: 'fetch',
      companyNumber: '99999999',
    });
  });

  test('an unmapped organisation is resolved with its register location', async () => {
    const { reads } = readsFor({ location: onRegister });
    const source = await profileSource(reads);
    expect(source).toEqual({ kind: 'resolve', location: onRegister });
  });

  test('a never-verified ingestion stub is resolved like an unmapped organisation', async () => {
    const { made, reads } = readsFor({ mapping: stub, location: onRegister });
    expect(await profileSource(reads)).toEqual({
      kind: 'resolve',
      location: onRegister,
    });
    expect(made).toEqual(['mapping', 'registerRow']);
  });

  test('a mapping with a company number is used even if never verified', async () => {
    const { reads } = readsFor({
      mapping: { ...mapped, verifiedAt: null },
      cached,
      location: onRegister,
    });
    expect(await profileSource(reads)).toEqual({ kind: 'cached', row: cached });
  });
});
