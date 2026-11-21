import { describe, expect, test } from 'bun:test';

import { markAskAccess } from './access-hint.server';
import type { AskStanding } from './access.server';

/** Marks a document for a request of the given standing, recording what was done to the hint. */
async function marked(standing: AskStanding): Promise<string[]> {
  const did: string[] = [];
  await markAskAccess(async () => standing, {
    ensure: () => void did.push('ensure'),
    expire: () => void did.push('expire'),
  });
  return did;
}

describe('markAskAccess', () => {
  test('the owner’s document, and a local run’s, leave the hint', async () => {
    expect(await marked('owner')).toEqual(['ensure']);
    expect(await marked('local')).toEqual(['ensure']);
  });

  test('a request that may not ask has a stale hint taken off', async () => {
    expect(await marked(null)).toEqual(['expire']);
  });

  test('while asking is public a visitor’s document gains no hint, and one left from a credential that has lapsed is taken off', async () => {
    expect(await marked('public')).toEqual(['expire']);
  });
});
