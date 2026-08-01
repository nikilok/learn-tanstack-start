/**
 * Scoring for the hand-labelled precision sample that gates which evidence
 * tiers may be published.
 *
 * `crn_on_page` needs no sample: the page carries the company's own
 * registration number, so it proves itself. `registry` does not — it is a
 * regulator asserting a URL, which is accurate far more often than not but
 * goes stale silently. This module turns a pile of yes/no judgements into the
 * one decision that matters: may that tier join PUBLISHABLE_EVIDENCE.
 */

/** What a human decided about one sampled row. */
export type Verdict = 'correct' | 'wrong' | 'unsure';

export type TierScore = {
  tier: string;
  labelled: number;
  correct: number;
  wrong: number;
  unsure: number;
  /** Unsure counted as wrong. The figure the decision is made on. */
  precision: number;
  /** Unsure excluded. The best the tier could possibly be. */
  optimistic: number;
  /** One-sided 95% Wilson lower bound on `precision`. */
  lowerBound: number;
  verdict: 'promote' | 'hold' | 'inconclusive';
};

/** A tier may be published when we are confident its precision clears this. */
export const PRECISION_FLOOR = 0.95;

/**
 * Wilson score lower bound for a binomial proportion.
 *
 * Not `p ± 1.96·√(p(1−p)/n)`: the normal approximation is badly wrong exactly
 * where this sample will land — near p=1, where it produces bounds above 1 and
 * collapses to zero width at 20/20. Wilson stays inside [0,1] and keeps a
 * sensible width on a small sample with few failures.
 */
export function wilsonLowerBound(
  successes: number,
  n: number,
  z = 1.645,
): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denominator);
}

/**
 * Score one tier's labels.
 *
 * `unsure` counts as wrong rather than being dropped. A row nobody could
 * resolve is a row we should not be publishing, and excluding it would let a
 * sample of 200 mostly-unsure labels read as perfect precision.
 */
export function scoreTier(tier: string, verdicts: Verdict[]): TierScore {
  const correct = verdicts.filter((v) => v === 'correct').length;
  const wrong = verdicts.filter((v) => v === 'wrong').length;
  const unsure = verdicts.filter((v) => v === 'unsure').length;
  const labelled = verdicts.length;
  const resolved = correct + wrong;

  const precision = labelled === 0 ? 0 : correct / labelled;
  const optimistic = resolved === 0 ? 0 : correct / resolved;
  const lowerBound = wilsonLowerBound(correct, labelled);

  // Three outcomes, not two. `hold` means the tier is genuinely below the
  // floor even at its best; `inconclusive` means the sample is too small or
  // too unresolved to tell, which is a call to label more rather than a
  // verdict on the data.
  let verdict: TierScore['verdict'];
  // Nothing labelled says nothing about the tier. Falling through to `hold`
  // printed "the tier is below the floor" for a measurement never made, which
  // is reachable any time a tier draws zero rows (--control=0, say).
  if (labelled === 0) verdict = 'inconclusive';
  else if (lowerBound >= PRECISION_FLOOR) verdict = 'promote';
  else if (optimistic < PRECISION_FLOOR) verdict = 'hold';
  else verdict = 'inconclusive';

  return {
    tier,
    labelled,
    correct,
    wrong,
    unsure,
    precision,
    optimistic,
    lowerBound,
    verdict,
  };
}

/**
 * The largest number of wrong-or-unsure labels a sample of `n` may carry and
 * still clear the floor. Derived from the same Wilson bound the verdict uses,
 * because a hardcoded allowance is only ever right at one sample size.
 *
 * Returns -1 when no number of clean labels would clear it, which is every `n`
 * below minimumSampleForPromotion. Callers must say so rather than print it.
 */
export function maxFailuresFor(n: number): number {
  for (let failures = 0; failures <= n; failures += 1) {
    if (wilsonLowerBound(n - failures, n) < PRECISION_FLOOR)
      return failures - 1;
  }
  return n;
}

/**
 * How many rows a tier needs before a clean run of labels could clear the
 * floor at all. Below this the answer is always `inconclusive`, so it is worth
 * knowing before anyone starts labelling.
 */
export function minimumSampleForPromotion(): number {
  let n = 1;
  while (wilsonLowerBound(n, n) < PRECISION_FLOOR && n < 10_000) n += 1;
  return n;
}
