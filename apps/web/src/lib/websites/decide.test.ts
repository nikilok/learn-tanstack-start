import { describe, expect, test } from 'bun:test';

import type { ExistingWebsite, ProposedWebsite } from './decide.ts';
import {
  decideWebsite,
  evidenceConfidence,
  evidenceRank,
  statusForEvidence,
  upgradeOnlyPredicateSql,
  type WebsiteEvidence,
} from './decide.ts';

const existing = (over: Partial<ExistingWebsite> = {}): ExistingWebsite => ({
  url: 'https://www.example.co.uk',
  status: 'verified',
  evidence: 'registry',
  source: 'cqc',
  ...over,
});

const proposed = (over: Partial<ProposedWebsite> = {}): ProposedWebsite => ({
  url: 'https://www.example.co.uk',
  evidence: 'registry',
  source: 'cqc',
  ...over,
});

describe('statusForEvidence', () => {
  test('registry and page-found evidence are verified', () => {
    expect(statusForEvidence('crn_on_page')).toBe('verified');
    expect(statusForEvidence('registry')).toBe('verified');
    expect(statusForEvidence('postcode_on_page')).toBe('verified');
    expect(statusForEvidence('manual')).toBe('verified');
  });

  test('uncorroborated evidence stays a candidate and is never rendered', () => {
    expect(statusForEvidence('llm_adjudicated')).toBe('candidate');
    expect(statusForEvidence('domain_similarity')).toBe('candidate');
    expect(statusForEvidence('registry_unconfirmed')).toBe('candidate');
  });

  test('none is its own terminal status, not a candidate', () => {
    expect(statusForEvidence('none')).toBe('none');
  });
});

describe('evidenceRank', () => {
  test('orders the ladder as documented', () => {
    const ladder: WebsiteEvidence[] = [
      'none',
      'domain_similarity',
      'registry_unconfirmed',
      'llm_adjudicated',
      'postcode_on_page',
      'registry',
      'crn_on_page',
      'manual',
    ];
    const ranks = ladder.map(evidenceRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test('every candidate tier ranks below every verified tier', () => {
    const candidates: WebsiteEvidence[] = [
      'domain_similarity',
      'registry_unconfirmed',
      'llm_adjudicated',
    ];
    const verified: WebsiteEvidence[] = [
      'postcode_on_page',
      'registry',
      'crn_on_page',
      'manual',
    ];
    const ceiling = Math.max(...candidates.map(evidenceRank));
    const floor = Math.min(...verified.map(evidenceRank));
    expect(ceiling).toBeLessThan(floor);
  });

  test('an unconfirmed registry row is not promoted by an LLM agreeing', () => {
    // The two tie deliberately, so neither can overwrite the other.
    expect(evidenceRank('registry_unconfirmed')).toBe(
      evidenceRank('llm_adjudicated'),
    );
  });

  test('confidence orders identically to rank, so SQL can guard on it', () => {
    // A writer enforces upgrade-only with `confidence < $new`; if the two ever
    // disagree, that guard silently stops matching the ladder.
    const all: WebsiteEvidence[] = [
      'none',
      'domain_similarity',
      'registry_unconfirmed',
      'llm_adjudicated',
      'postcode_on_page',
      'registry',
      'crn_on_page',
      'manual',
    ];
    for (const a of all) {
      for (const b of all) {
        expect(
          Math.sign(evidenceRank(a) - evidenceRank(b)),
          `rank/confidence disagree for ${a} vs ${b}`,
        ).toBe(Math.sign(evidenceConfidence(a) - evidenceConfidence(b)));
      }
    }
  });
});

describe('decideWebsite', () => {
  test('writes when there is nothing stored', () => {
    expect(decideWebsite(null, proposed())).toEqual({ action: 'update' });
  });

  test('promotes on stronger evidence', () => {
    const result = decideWebsite(
      existing({ evidence: 'llm_adjudicated', status: 'candidate' }),
      proposed({ evidence: 'crn_on_page' }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('never demotes on weaker evidence, even with a different url', () => {
    const result = decideWebsite(
      existing({ evidence: 'crn_on_page' }),
      proposed({ evidence: 'domain_similarity', url: 'https://other.co.uk' }),
    );
    expect(result).toEqual({ action: 'keep' });
  });

  test('an owner-set website outranks every discoverer', () => {
    const result = decideWebsite(
      existing({ evidence: 'manual' }),
      proposed({ evidence: 'crn_on_page', url: 'https://other.co.uk' }),
    );
    expect(result).toEqual({ action: 'conflict' });
  });

  test('a discoverer agreeing with the owner is a no-op, not a conflict', () => {
    const result = decideWebsite(
      existing({ evidence: 'manual' }),
      proposed({ evidence: 'crn_on_page' }),
    );
    expect(result).toEqual({ action: 'keep' });
  });

  test('two registries naming the same site agree silently', () => {
    expect(decideWebsite(existing(), proposed())).toEqual({ action: 'keep' });
  });

  test('two DIFFERENT registries naming different sites surface as a conflict', () => {
    // CQC and Wikidata overlap on ~23 companies; run order must not decide.
    const result = decideWebsite(
      existing({ url: 'https://cqc-says.co.uk', source: 'cqc' }),
      proposed({ url: 'https://wikidata-says.co.uk', source: 'wikidata' }),
    );
    expect(result).toEqual({ action: 'conflict' });
  });

  test('the SAME registry revising its own address is an update, not a standoff', () => {
    // A provider moving domains is the common case, and it arrives at the same
    // rank from the same source. Treating it as a conflict froze the stale URL
    // permanently: a later 'dead' status never lowers `evidence`, so the
    // correction could never outrank the value it was meant to replace.
    const result = decideWebsite(
      existing({ url: 'https://old-domain.co.uk', source: 'cqc' }),
      proposed({ url: 'https://new-domain.co.uk', source: 'cqc' }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('a same-source correction still works once the row went dead', () => {
    const result = decideWebsite(
      existing({
        url: 'https://old-domain.co.uk',
        source: 'cqc',
        status: 'dead',
      }),
      proposed({ url: 'https://new-domain.co.uk', source: 'cqc' }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('the SQL guard admits every case decideWebsite calls an update', () => {
    // The bug this pins: decideWebsite gained same-source corrections while the
    // hand-written SQL still required a strictly HIGHER confidence, so a
    // registry revising its own URL was accepted in process and then silently
    // dropped by the database (0.95 < 0.95 is false). Both now come from
    // upgradeOnlyPredicateSql, and these are the clauses that make the three
    // update paths reachable.
    const predicate = upgradeOnlyPredicateSql();
    // stronger tier wins
    expect(predicate).toContain(
      'company_websites.confidence < excluded.confidence',
    );
    // same tier wins when, and only when, it is the same source
    expect(predicate).toContain(
      'company_websites.confidence = excluded.confidence AND company_websites.source = excluded.source',
    );
    // manual stays terminal
    expect(predicate).toContain("company_websites.evidence <> 'manual'");
  });

  test('the SQL guard is emitted for the table it is applied to', () => {
    expect(upgradeOnlyPredicateSql('other_table')).not.toContain(
      'company_websites',
    );
    expect(upgradeOnlyPredicateSql('other_table')).toContain('other_table');
  });

  test('an unknown prior source cannot claim to be the same source', () => {
    const result = decideWebsite(
      existing({ url: 'https://a.co.uk', source: null }),
      proposed({ url: 'https://b.co.uk', source: 'cqc' }),
    );
    expect(result).toEqual({ action: 'conflict' });
  });

  test('an empty finding never overwrites a stored answer', () => {
    expect(
      decideWebsite(existing(), proposed({ evidence: 'none', url: null })),
    ).toEqual({ action: 'keep' });
    expect(decideWebsite(existing(), proposed({ url: null }))).toEqual({
      action: 'keep',
    });
  });

  test('a dead row is revived by fresh evidence', () => {
    const result = decideWebsite(
      existing({ status: 'dead', evidence: 'domain_similarity' }),
      proposed({ evidence: 'registry' }),
    );
    expect(result).toEqual({ action: 'update' });
  });
});

describe('decideWebsite — dead rows accept corrections', () => {
  test('a dead row does not outrank a fresh address from a weaker source', () => {
    // Identity evidence is evidence about a URL. Once the sweep proves that URL
    // is gone, crn_on_page (0.99) must stop blocking the registry's new one
    // (0.95) — otherwise a company that moves domain is frozen dead forever and
    // every monthly import silently discards the correction.
    const result = decideWebsite(
      existing({
        url: 'https://old-domain.co.uk',
        evidence: 'crn_on_page',
        status: 'dead',
      }),
      proposed({ url: 'https://new-domain.co.uk', evidence: 'registry' }),
    );
    expect(result).toEqual({ action: 'update' });
  });

  test('a dead row naming the same site is still a no-op', () => {
    const result = decideWebsite(
      existing({
        url: 'https://www.acme.co.uk',
        evidence: 'crn_on_page',
        status: 'dead',
      }),
      proposed({ url: 'https://acme.co.uk', evidence: 'registry' }),
    );
    expect(result).toEqual({ action: 'keep' });
  });

  test('a LIVE row keeps outranking a weaker proposal, as before', () => {
    const result = decideWebsite(
      existing({ evidence: 'crn_on_page', status: 'verified' }),
      proposed({ url: 'https://other.co.uk', evidence: 'registry' }),
    );
    expect(result).toEqual({ action: 'keep' });
  });

  test('the SQL guard admits dead-row corrections too', () => {
    expect(upgradeOnlyPredicateSql()).toContain(
      "company_websites.status = 'dead'",
    );
  });
});
