import { describe, expect, test } from 'bun:test';

import {
  minimumSampleForPromotion,
  PRECISION_FLOOR,
  scoreTier,
  type Verdict,
} from './precision';

/** n labels, `wrong` of them wrong, the rest correct. */
function labels(n: number, wrong = 0, unsure = 0): Verdict[] {
  return [
    ...Array<Verdict>(n - wrong - unsure).fill('correct'),
    ...Array<Verdict>(wrong).fill('wrong'),
    ...Array<Verdict>(unsure).fill('unsure'),
  ];
}

describe('wilsonLowerBound via scoreTier', () => {
  test('a perfect small sample is NOT enough to promote', () => {
    // The trap this exists to avoid: 20/20 reads as 100% precision, and the
    // normal approximation gives it a confidence interval of zero width.
    const score = scoreTier('registry', labels(20));
    expect(score.precision).toBe(1);
    expect(score.lowerBound).toBeLessThan(PRECISION_FLOOR);
    expect(score.verdict).toBe('inconclusive');
  });

  test('a perfect sample of 200 clears the floor', () => {
    const score = scoreTier('registry', labels(200));
    expect(score.lowerBound).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    expect(score.verdict).toBe('promote');
  });

  test('exactly at the floor is not confidently at the floor', () => {
    // 190/200 is a point estimate of exactly 95%, but the sample is equally
    // consistent with 91%. Promoting on the point estimate alone is how a tier
    // ships at 92% precision.
    const score = scoreTier('registry', labels(200, 10));
    expect(score.precision).toBeCloseTo(0.95, 5);
    expect(score.lowerBound).toBeLessThan(PRECISION_FLOOR);
    expect(score.verdict).toBe('inconclusive');
  });

  test('a tier that is genuinely bad is held, not called inconclusive', () => {
    const score = scoreTier('registry', labels(200, 40));
    expect(score.optimistic).toBeCloseTo(0.8, 5);
    expect(score.verdict).toBe('hold');
  });
});

describe('unsure labels', () => {
  test('count as wrong, so an unresolved sample cannot read as perfect', () => {
    // Dropping unsure would make 100 correct and 100 unsure score 100%.
    const score = scoreTier('registry', labels(200, 0, 100));
    expect(score.precision).toBe(0.5);
    expect(score.optimistic).toBe(1);
    expect(score.verdict).toBe('inconclusive');
  });

  test('are reported separately so the fix is obvious', () => {
    const score = scoreTier('registry', labels(200, 5, 15));
    expect(score.correct).toBe(180);
    expect(score.wrong).toBe(5);
    expect(score.unsure).toBe(15);
    // Resolving the 15 unsures is what would move this, not sampling more.
    expect(score.optimistic).toBeCloseTo(180 / 185, 5);
  });
});

describe('minimumSampleForPromotion', () => {
  test('a flawless run still needs a real sample size', () => {
    const n = minimumSampleForPromotion();
    expect(n).toBeGreaterThan(50);
    expect(scoreTier('t', labels(n)).verdict).toBe('promote');
    expect(scoreTier('t', labels(n - 1)).verdict).toBe('inconclusive');
  });
});

describe('empty input', () => {
  test('scores as inconclusive rather than dividing by zero', () => {
    const score = scoreTier('registry', []);
    expect(score.precision).toBe(0);
    expect(score.lowerBound).toBe(0);
    expect(score.verdict).toBe('hold');
  });
});
