import { describe, expect, test } from 'bun:test';

import type { ExistingWebsite } from './decide';
import {
  decideRegistryFinding,
  type RegistryFinding,
  type RegistryWrite,
} from './registry-import';

const NOW = new Date('2026-11-16T12:00:00Z');
const MAIN = 'https://www.quillmere.co.uk';
const STAGING = 'https://www.staging.quillmere.co.uk';
const OTHER = 'https://www.hestwick.co.uk';
const NAME = 'QUILLMERE CARE LIMITED';

const finding = (over: Partial<RegistryFinding> = {}): RegistryFinding => ({
  companyNumber: '09990117',
  url: MAIN,
  registryName: 'Quillmere Care Limited',
  source: 'cqc',
  ...over,
});

const stored = (over: Partial<ExistingWebsite> = {}): ExistingWebsite => ({
  url: MAIN,
  status: 'verified',
  evidence: 'registry',
  source: 'cqc',
  ...over,
});

/** The decision for one finding against a stored row, or none, with nothing written earlier in the run. */
const decide = (found: RegistryFinding, row: ExistingWebsite | null) =>
  decideRegistryFinding(found, NAME, { stored: row, pending: null }, NOW);

/** One company's findings decided in the importer's order, each against the stored row and the write before it. */
function run(row: ExistingWebsite | null, ...found: RegistryFinding[]) {
  let pending: RegistryWrite | null = null;
  const decisions = found.map((next) => {
    const decision = decideRegistryFinding(
      next,
      NAME,
      { stored: row, pending },
      NOW,
    );
    if (decision.action === 'write') pending = decision.write;
    return decision;
  });
  return { decisions, write: pending as RegistryWrite | null };
}

describe('decideRegistryFinding', () => {
  test('a company with no row is written at the register tier, verified now', () => {
    expect(decide(finding(), null)).toEqual({
      action: 'write',
      unconfirmed: false,
      stagingCopy: false,
      write: {
        companyNumber: '09990117',
        url: MAIN,
        status: 'verified',
        evidence: 'registry',
        confidence: '0.950',
        source: 'cqc',
        verifiedAt: NOW,
      },
    });
  });

  test("a CQC name that is not the company's lands unconfirmed, as a candidate", () => {
    const decision = decide(
      finding({ registryName: 'Northgate Homes Limited' }),
      null,
    );
    expect(decision).toMatchObject({
      action: 'write',
      unconfirmed: true,
      write: {
        status: 'candidate',
        evidence: 'registry_unconfirmed',
        confidence: '0.600',
        verifiedAt: null,
      },
    });
  });

  test("Wikidata's label is the brand, so it is never checked against the registered name", () => {
    const decision = decide(
      finding({ source: 'wikidata', registryName: 'Northgate' }),
      null,
    );
    expect(decision).toMatchObject({
      unconfirmed: false,
      write: { evidence: 'registry', source: 'wikidata' },
    });
  });

  test('the address the row already holds is not news', () => {
    expect(decide(finding(), stored()).action).toBe('keep');
    // Counted even when nothing is written.
    expect(
      decide(finding({ registryName: 'Northgate Homes Limited' }), stored()),
    ).toMatchObject({ action: 'keep', unconfirmed: true });
  });

  test('a register correcting its own address is written', () => {
    const moved = 'https://www.quillmere-care.co.uk';
    expect(decide(finding({ url: moved }), stored())).toMatchObject({
      action: 'write',
      stagingCopy: false,
      write: { url: moved, status: 'verified' },
    });
  });

  test('two registers naming different sites is a conflict', () => {
    const other = 'https://www.quillmere-group.com';
    expect(
      decide(finding({ source: 'wikidata', url: other }), stored()).action,
    ).toBe('conflict');
  });

  describe("a verdict the sweep reached about the row's page", () => {
    const unconfirmed = (status: ExistingWebsite['status']) =>
      stored({ status, evidence: 'registry_unconfirmed' });

    test('survives an identity upgrade on the same site', () => {
      for (const status of ['unreachable', 'dead', 'candidate'] as const) {
        expect(
          decide(
            finding({ url: 'https://quillmere.co.uk' }),
            unconfirmed(status),
          ),
        ).toMatchObject({
          action: 'write',
          write: { status, evidence: 'registry', verifiedAt: null },
        });
      }
    });

    test('does not follow the row to another site', () => {
      expect(
        decide(
          finding({ url: 'https://www.quillmere-care.co.uk' }),
          unconfirmed('unreachable'),
        ),
      ).toMatchObject({ write: { status: 'verified', verifiedAt: NOW } });
    });
  });

  describe('a register that lists a staging copy of the site the row holds', () => {
    // 2026-11-02: an owner's repoint moved a register row from a staging copy
    // to the site's main domain, and the next import put the staging address back.
    test('leaves the row on its main domain', () => {
      expect(decide(finding({ url: STAGING }), stored())).toEqual({
        action: 'keep',
        unconfirmed: false,
        stagingCopy: true,
      });
    });

    test('whatever the row has since been proved at', () => {
      for (const evidence of [
        'registry',
        'registry_confirmed',
        'crn_on_page',
        'manual',
      ] as const) {
        expect(
          decide(finding({ url: STAGING }), stored({ evidence })),
        ).toMatchObject({ action: 'keep', stagingCopy: true });
      }
    });

    test('still raises the tier, on the address the row holds', () => {
      const decision = decide(
        finding({ url: STAGING }),
        stored({ status: 'candidate', evidence: 'registry_unconfirmed' }),
      );
      expect(decision).toMatchObject({
        action: 'write',
        stagingCopy: true,
        // The sweep's verdict stays too: the page is the one it judged.
        write: { url: MAIN, evidence: 'registry', status: 'candidate' },
      });
    });

    test('is one site with it for a second register, not a disagreement', () => {
      expect(
        decide(finding({ source: 'wikidata', url: STAGING }), stored()),
      ).toMatchObject({ action: 'keep', stagingCopy: true });
    });

    test('never replaces a dead main domain with its copy', () => {
      expect(
        decide(finding({ url: STAGING }), stored({ status: 'dead' })),
      ).toMatchObject({ action: 'keep', stagingCopy: true });
    });
  });

  test('a row on the staging copy is corrected to the main domain when its register lists that', () => {
    expect(decide(finding(), stored({ url: STAGING }))).toMatchObject({
      action: 'write',
      stagingCopy: false,
      write: { url: MAIN },
    });
  });

  test('a staging host of another site replaces the row as any address does', () => {
    const other = 'https://staging.hestwick.co.uk';
    expect(decide(finding({ url: other }), stored())).toMatchObject({
      action: 'write',
      stagingCopy: false,
      write: { url: other },
    });
  });

  describe('a second register, after the first has written in the same run', () => {
    /** CQC under a name that is not the company's: its write lands below the register tier. */
    const cqcUnconfirmed = (url: string) =>
      finding({ url, registryName: 'Northgate Homes Limited' });
    const wikidata = (url: string) => finding({ source: 'wikidata', url });

    test('is decided on the ladder against what the first wrote, not what is stored', () => {
      // CQC moved its own address; Wikidata still names the stored one.
      const { decisions, write } = run(
        stored(),
        finding({ url: OTHER }),
        wikidata(MAIN),
      );
      expect(decisions.map((d) => d.action)).toEqual(['write', 'conflict']);
      expect(write).toMatchObject({ url: OTHER, source: 'cqc' });
    });

    test('keeps the verdict the sweep reached about the stored page, whatever the first wrote', () => {
      for (const status of ['unreachable', 'dead', 'candidate'] as const) {
        const { write } = run(
          stored({ status, evidence: 'registry_unconfirmed' }),
          cqcUnconfirmed(OTHER),
          wikidata(MAIN),
        );
        expect(write).toMatchObject({
          url: MAIN,
          status,
          evidence: 'registry',
          verifiedAt: null,
        });
      }
    });

    test("does not take the first register's own candidate for a verdict of the sweep", () => {
      const { write } = run(null, cqcUnconfirmed(MAIN), wikidata(MAIN));
      expect(write).toMatchObject({
        url: MAIN,
        status: 'verified',
        evidence: 'registry',
        verifiedAt: NOW,
      });
    });

    test('a staging copy of the stored site is still read as that site', () => {
      const { decisions, write } = run(
        stored({ status: 'unreachable', evidence: 'registry_unconfirmed' }),
        cqcUnconfirmed(OTHER),
        wikidata(STAGING),
      );
      expect(decisions[1]).toMatchObject({
        action: 'write',
        stagingCopy: true,
      });
      // On the stored address, so the sweep's verdict on it stays as well.
      expect(write).toMatchObject({
        url: MAIN,
        status: 'unreachable',
        evidence: 'registry',
      });
    });

    test('a staging copy of the address the first wrote is read as that address', () => {
      const raised = run(null, cqcUnconfirmed(MAIN), wikidata(STAGING));
      expect(raised.decisions[1]).toMatchObject({ stagingCopy: true });
      expect(raised.write).toMatchObject({ url: MAIN, evidence: 'registry' });
      // At the same tier it is one site with it, not a disagreement.
      const same = run(null, finding(), wikidata(STAGING));
      expect(same.decisions[1]).toEqual({
        action: 'keep',
        unconfirmed: false,
        stagingCopy: true,
      });
    });

    test('a copy of both is read as the address written this run', () => {
      // Stored at the site's root; CQC now lists one business under it.
      const { write } = run(
        stored({ evidence: 'registry_unconfirmed' }),
        cqcUnconfirmed(`${MAIN}/arun`),
        wikidata('https://staging.quillmere.co.uk/arun'),
      );
      expect(write).toMatchObject({
        url: `${MAIN}/arun`,
        evidence: 'registry',
      });
    });
  });
});
