import { describe, expect, test } from 'bun:test';

import type { WebsiteEvidence, WebsiteStatus } from './decide.ts';
import {
  decideWebsite,
  evidenceConfidence,
  evidenceRank,
  statusForEvidence,
  upgradeOnlyPredicateSql,
} from './decide.ts';
import type { RevalidateFailure, RevalidateInput } from './revalidate.ts';
import { mergeRevalidation, revalidate } from './revalidate.ts';

/**
 * Property tests over the whole revalidation state machine.
 *
 * Three review rounds produced 35 findings, and nine of the last fifteen were
 * regressions from fixing earlier ones. The reason is that the machine has six
 * interacting dimensions — status, evidence, failure count, fetch outcome, HTTP
 * status, disclosure result — with its transitions spread across four modules,
 * so a fix that satisfies one finding quietly violates an invariant reached by
 * a different route.
 *
 * The findings kept landing on the same three properties. Asserting them across
 * the enumerated state space, rather than testing transitions one at a time, is
 * what turns the next regression into a failing test instead of the next
 * review's finding.
 */

const STATUSES: WebsiteStatus[] = [
  'pending',
  'verified',
  'candidate',
  'unreachable',
  'none',
  'dead',
];

const EVIDENCES: WebsiteEvidence[] = [
  'none',
  'domain_similarity',
  'registry_unconfirmed',
  'llm_adjudicated',
  'postcode_on_page',
  'registry',
  'registry_confirmed',
  'crn_on_page',
  'manual',
];

const FAILURES: { reason: RevalidateFailure; status?: number }[] = [
  { reason: 'dns_or_refused' },
  { reason: 'tls' },
  { reason: 'timeout' },
  { reason: 'private_address' },
  { reason: 'blocked_by_robots' },
  { reason: 'not_html' },
  { reason: 'too_large' },
  { reason: 'http_error', status: 403 },
  { reason: 'http_error', status: 404 },
  { reason: 'http_error', status: 410 },
  { reason: 'http_error', status: 429 },
  { reason: 'http_error', status: 503 },
];

const STORED_URL = 'https://www.example.co.uk';

type Case = {
  label: string;
  input: RevalidateInput;
};

/** Every (stored state × outcome × disclosure) combination the sweep can reach. */
function* allCases(): Generator<Case> {
  const outcomes: { label: string; outcome: RevalidateInput['outcome'] }[] = [
    { label: 'ok', outcome: { ok: true } },
    ...FAILURES.map((f) => ({
      label: `${f.reason}${f.status ? `/${f.status}` : ''}`,
      outcome: { ok: false as const, ...f },
    })),
  ];
  const disclosures = [
    { label: 'nothing', crnFoundAt: null, postcodeFoundAt: null },
    { label: 'crn', crnFoundAt: `${STORED_URL}/terms`, postcodeFoundAt: null },
    {
      label: 'postcode',
      crnFoundAt: null,
      postcodeFoundAt: `${STORED_URL}/contact`,
    },
  ];

  // Page-shape signals, enumerated alongside the disclosure findings. Leaving
  // them permanently undefined meant the machine's only DOWNWARD transition —
  // and the only thing that can unpublish a live row — sat outside every
  // invariant below.
  const pageShapes = [
    {
      label: 'plain',
      postcodeConfirms: false,
      onAggregator: false,
      looksParked: false,
    },
    {
      label: 'corroborated',
      postcodeConfirms: true,
      onAggregator: false,
      looksParked: false,
    },
    {
      label: 'parked',
      postcodeConfirms: false,
      onAggregator: false,
      looksParked: true,
    },
    {
      label: 'aggregator',
      postcodeConfirms: false,
      onAggregator: true,
      looksParked: false,
    },
    {
      label: 'confirmed+aggregator',
      postcodeConfirms: true,
      onAggregator: true,
      looksParked: false,
    },
    {
      label: 'confirmed+parked',
      postcodeConfirms: true,
      onAggregator: false,
      looksParked: true,
    },
  ];

  for (const status of STATUSES) {
    for (const evidence of EVIDENCES) {
      for (const failureCount of [0, 1, 2]) {
        for (const o of outcomes) {
          for (const d of disclosures) {
            // Disclosure findings only exist when a page was actually read.
            if (!o.outcome.ok && d.label !== 'nothing') continue;
            for (const p of pageShapes) {
              // Nor do page-shape signals: there is no page to shape.
              if (!o.outcome.ok && p.label !== 'plain') continue;
              yield {
                label: `${status}/${evidence}/f${failureCount} + ${o.label} + ${d.label} + ${p.label}`,
                input: {
                  storedUrl: STORED_URL,
                  evidence,
                  status,
                  failureCount,
                  attemptedUrl: STORED_URL,
                  outcome: o.outcome,
                  crnFoundAt: d.crnFoundAt,
                  postcodeFoundAt: d.postcodeFoundAt,
                  postcodeConfirms: p.postcodeConfirms,
                  onAggregator: p.onAggregator,
                  looksParked: p.looksParked,
                },
              };
            }
          }
        }
      }
    }
  }
}

const CASES = [...allCases()];

describe('state machine invariants', () => {
  test('the enumeration is actually exercising the space', () => {
    expect(CASES.length).toBeGreaterThan(1000);
  });

  /**
   * I1. The render gate is `status = 'verified' AND checked_at IS NOT NULL`,
   * and revalidate stamps checked_at on EVERY pass. So a pass that returns
   * 'verified' is publishing a link, and it may only do that if it just
   * fetched the stored URL and got a page back.
   *
   * This is the invariant the whole sweep exists to enforce, and it is the one
   * most often violated by a side door: a robots ban and a 403 both mean the
   * URL itself was never read.
   */
  test('I1 — only a successful fetch of the stored url may render', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      const r = revalidate(c.input);
      if (r.status === 'verified' && !c.input.outcome.ok) {
        violations.push(c.label);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /**
   * I2. Anything permanently broken must eventually be written off. If an
   * outcome is not a successful fetch, the row must move measurably closer to
   * `dead` — either its failure count rises or it is already there. A branch
   * that resets the counter makes DEAD_AFTER_FAILURES unreachable and leaves a
   * broken link published forever.
   */
  test('I2 — a failed fetch always moves the row toward dead', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      if (c.input.outcome.ok) continue;
      const r = revalidate(c.input);
      const progressed =
        r.failureCount > c.input.failureCount || r.status === 'dead';
      if (!progressed)
        violations.push(`${c.label} -> f${r.failureCount}/${r.status}`);
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /**
   * I3. Evidence is a claim about the stored URL, and it may only rise when
   * this pass actually found the proof. Anything else lets a tier drift upward
   * on no evidence at all.
   *
   * `postcodeConfirms` counts as proof — it is read off the page this pass
   * fetched, like the other two. It is listed explicitly rather than left
   * implicit so that adding a fourth signal fails here until someone decides
   * whether it is proof, which is the question this invariant exists to force.
   */
  test('I3 — evidence never rises without proof found this pass', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      const r = revalidate(c.input);
      const foundSomething = Boolean(
        c.input.crnFoundAt ||
        c.input.postcodeFoundAt ||
        c.input.postcodeConfirms,
      );
      if (
        !foundSomething &&
        evidenceRank(r.evidence) > evidenceRank(c.input.evidence)
      ) {
        violations.push(`${c.label} -> ${r.evidence}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I4. The URL written is never invented: it is the stored one or the
   *  variant that answered. */
  test('I4 — the written url is always one we actually tried', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      const r = revalidate(c.input);
      if (r.url !== c.input.storedUrl && r.url !== c.input.attemptedUrl) {
        violations.push(`${c.label} -> ${r.url}`);
      }
    }
    expect(violations).toEqual([]);
  });

  /** I5. A failed pass must never rewrite the URL: we learned nothing about
   *  where the company's site is, only that this one did not answer. */
  test('I5 — a failed pass leaves the url alone', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      if (c.input.outcome.ok) continue;
      const r = revalidate({
        ...c.input,
        attemptedUrl: 'https://variant.example',
      });
      if (r.url !== c.input.storedUrl) violations.push(c.label);
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I6. Confidence is the ladder's numeric proxy AND the column the SQL
   *  upgrade guards compare, so it must agree with the evidence tier written
   *  beside it — in both directions.
   *
   *  This invariant used to say "never slips backwards", which was safe only
   *  while revalidate could not lower a tier. Once registry_confirmed became
   *  revocable, monotonic confidence left 0.970 on a row demoted to `registry`
   *  and upgradeOnlyPredicateSql then rejected every correction the registry
   *  published for that company, permanently. Disagreement between the two
   *  columns is the defect; a decrease is not. */
  test('I6 — merged confidence always matches the merged evidence', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      const r = revalidate(c.input);
      for (const stored of [null, '0.400', '0.950', '0.990', '1.000']) {
        const merged = mergeRevalidation(
          {
            url: c.input.storedUrl,
            evidence: c.input.evidence,
            evidenceUrl: null,
            confidence: stored,
          },
          r,
        );
        const expected = evidenceConfidence(merged.evidence).toFixed(3);
        if (merged.confidence !== expected) {
          violations.push(
            `${c.label} stored=${stored} -> ${merged.evidence}/${merged.confidence}, expected ${expected}`,
          );
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I7. A proof page already on file is never destroyed by a pass that found
   *  nothing — disclosure probing is first-pass-only, so a wipe is permanent. */
  test('I7 — a stored proof page survives a pass that found nothing', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      const r = revalidate(c.input);
      const merged = mergeRevalidation(
        {
          url: c.input.storedUrl,
          evidence: c.input.evidence,
          evidenceUrl: 'https://acme.co.uk/contact',
          confidence: '0.990',
        },
        r,
      );
      if (merged.evidenceUrl === null) violations.push(c.label);
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I8. `manual` is an owner decision about identity. Liveness may change the
   *  status, but nothing automatic may change the tier. */
  test('I8 — a manual tier is never overwritten', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      if (c.input.evidence !== 'manual') continue;
      const r = revalidate(c.input);
      if (r.evidence !== 'manual')
        violations.push(`${c.label} -> ${r.evidence}`);
    }
    expect(violations).toEqual([]);
  });
});

describe('decideWebsite invariants', () => {
  /**
   * I9. A dead row may be displaced by a fresh address, but only by evidence
   * good enough to render on its own. Without a floor, the weakest tier —
   * "the registry's name for this company does not match Companies House" —
   * could replace a proven company number at someone else's address, and two
   * timeouts are enough to make a row dead.
   */
  test('I9 — only render-worthy evidence may displace a dead row', () => {
    const violations: string[] = [];
    for (const evidence of EVIDENCES) {
      const result = decideWebsite(
        {
          url: 'https://acme.co.uk',
          status: 'dead',
          evidence: 'crn_on_page',
          source: 'cqc',
        },
        { url: 'https://someone-else.co.uk', evidence, source: 'cqc' },
      );
      const displaced = result.action === 'update';
      const worthy = statusForEvidence(evidence) === 'verified';
      if (displaced && !worthy)
        violations.push(`${evidence} displaced a proof`);
    }
    expect(violations).toEqual([]);
  });

  /** I10. The SQL predicate must admit exactly what decideWebsite admits: the
   *  dead-row clause carries the same floor, or the database accepts a write
   *  the in-process decision refused. */
  test('I10 — the SQL dead-row clause carries the evidence floor too', () => {
    const predicate = upgradeOnlyPredicateSql();
    expect(predicate).toContain("company_websites.status = 'dead'");
    expect(predicate).toMatch(/status = 'dead' AND excluded\.confidence >=/);
  });
});

describe('state machine invariants — the revocable rung', () => {
  /** I11. The HEURISTIC may not overturn a registered number found on the site
   *  or an owner's decision: looksParked fires on any short page saying "coming
   *  soon", and neither tier should fall to a phrase match. */
  test('I11 — looksParked never unpublishes manual or crn_on_page', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      if (!c.input.looksParked || c.input.onAggregator) continue;
      if (c.input.evidence !== 'manual' && c.input.evidence !== 'crn_on_page') {
        continue;
      }
      const r = revalidate(c.input);
      if (c.input.outcome.ok && r.status !== 'verified') {
        violations.push(`${c.label} -> ${r.status}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I14. The CERTAIN signal has no exemptions and suppresses promotion, not
   *  just rendering. A directory listing prints the registration number, so the
   *  crn check fires on exactly the hosts the deny-list rejects — and a tier
   *  written off a listing would also pin the row's confidence, blocking the
   *  registry from ever replacing the URL. */
  test('I14 — a directory listing never renders and never promotes', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      if (!c.input.onAggregator || !c.input.outcome.ok) continue;
      const r = revalidate(c.input);
      if (r.status === 'verified') {
        violations.push(`${c.label} rendered`);
      }
      if (evidenceRank(r.evidence) > evidenceRank(c.input.evidence)) {
        violations.push(`${c.label} promoted to ${r.evidence}`);
      }
      // Not promoting is not enough: a row already at registry_confirmed that
      // now lands on a directory must LOSE the rung. Leaving it latched keeps
      // a claim no page supports, and its 0.970 blocks the registry from ever
      // replacing the URL.
      if (r.evidence === 'registry_confirmed') {
        violations.push(`${c.label} kept its confirmation`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I12. Only registry/registry_confirmed may move on the corroboration
   *  signal. It was measured on registry rows alone, where it confirms a claim
   *  an exact company-number join already made; standing behind anything else
   *  it is a far weaker thing. */
  test('I12 — corroboration only ever moves the two confirmable tiers', () => {
    const violations: string[] = [];
    for (const c of CASES) {
      const r = revalidate(c.input);
      if (r.evidence === c.input.evidence) continue;
      const confirmable =
        c.input.evidence === 'registry' ||
        c.input.evidence === 'registry_confirmed';
      // A move to/from registry_confirmed is only legitimate from those two.
      if (
        (r.evidence === 'registry_confirmed' ||
          c.input.evidence === 'registry_confirmed') &&
        !confirmable
      ) {
        violations.push(`${c.label} -> ${r.evidence}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  /** I13. The withdrawal must be reversible with no state left behind: a row
   *  that loses corroboration and regains it must land exactly where it was,
   *  or the tier decays a little on every flap. */
  test('I13 — withdrawal then re-confirmation is a round trip', () => {
    const base = {
      storedUrl: 'https://www.example.co.uk',
      status: 'verified' as WebsiteStatus,
      failureCount: 0,
      attemptedUrl: 'https://www.example.co.uk',
      outcome: { ok: true } as const,
    };
    const withdrawn = revalidate({
      ...base,
      evidence: 'registry_confirmed',
      postcodeConfirms: false,
    });
    expect(withdrawn.evidence).toBe('registry');
    const regained = revalidate({
      ...base,
      evidence: withdrawn.evidence,
      postcodeConfirms: true,
    });
    expect(regained.evidence).toBe('registry_confirmed');
    expect(regained.confidence).toBe('0.970');
    expect(regained.status).toBe('verified');
  });
});
