import { describe, expect, test } from 'bun:test';

import { planCrawlRotation } from './sql';

const FLOOR = 1_000_000;

describe('planCrawlRotation', () => {
  test('two publishable urls on one origin fill ONE rotation slot together', () => {
    const targets = planCrawlRotation(
      [
        { url: 'https://franchise.co.uk/branch-a', companies: 1 },
        { url: 'https://franchise.co.uk/branch-b', companies: 2 },
        { url: 'https://other.co.uk', companies: 1 },
      ],
      new Map(),
      FLOOR,
      2,
    );
    expect(targets).toEqual([
      {
        origin: 'https://franchise.co.uk',
        urls: [
          'https://franchise.co.uk/branch-a',
          'https://franchise.co.uk/branch-b',
        ],
        companies: 3,
      },
      {
        origin: 'https://other.co.uk',
        urls: ['https://other.co.uk'],
        companies: 1,
      },
    ]);
  });

  test('the limit caps origins, and a group is never split across it', () => {
    const targets = planCrawlRotation(
      [
        { url: 'https://a.co.uk/one', companies: 1 },
        { url: 'https://a.co.uk/two', companies: 1 },
        { url: 'https://b.co.uk', companies: 1 },
      ],
      new Map(),
      FLOOR,
      1,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].urls).toHaveLength(2);
  });

  test('never-crawled origins outrank oldest-crawled; fresh ones are skipped', () => {
    const targets = planCrawlRotation(
      [
        { url: 'https://stale.co.uk', companies: 1 },
        { url: 'https://fresh.co.uk', companies: 1 },
        { url: 'https://never.co.uk', companies: 1 },
      ],
      new Map([
        ['https://stale.co.uk', FLOOR - 500],
        ['https://fresh.co.uk', FLOOR + 500],
      ]),
      FLOOR,
      10,
    );
    expect(targets.map((target) => target.origin)).toEqual([
      'https://never.co.uk',
      'https://stale.co.uk',
    ]);
  });

  test('null and malformed urls skip their rows, not the sweep', () => {
    const targets = planCrawlRotation(
      [
        { url: null, companies: 1 },
        { url: 'not a url', companies: 1 },
        { url: 'https://good.co.uk', companies: 1 },
      ],
      new Map(),
      FLOOR,
      10,
    );
    expect(targets.map((target) => target.origin)).toEqual([
      'https://good.co.uk',
    ]);
  });
});
