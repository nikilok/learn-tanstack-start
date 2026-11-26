import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from '../websites/fake-sql';
import type { CommitRestoreInput } from './method-restore';
import { makeCommitRestore, makeReadMovedJoins } from './method-restore-sql';

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const input: CommitRestoreInput = {
  organisationName: 'Westpac Banking Corporation',
  rowHash: 'hash of the join',
  auditId: 501,
  method: 'exact',
  score: 1,
  changedBy: 'uk_establishment_method_restore',
};

describe('makeReadMovedJoins', () => {
  test("each sponsor's newest audit row of the move that stored it manual, beside its join as stored now", async () => {
    const stored = {
      organisation_name: 'Westpac Banking Corporation',
      company_number: 'BR000106',
      match_method: 'manual',
    };
    const { sql, calls } = makeFakeSql([
      {
        audit_id: 501,
        newest_audit_id: 501,
        organisation_name: 'Westpac Banking Corporation',
        new_company_number: 'BR000106',
        old_match_method: 'exact',
        joined: true,
        stored,
        row_hash: 'hash of the join',
      },
      {
        audit_id: 502,
        newest_audit_id: 640,
        organisation_name: 'Gone Sponsor',
        new_company_number: 'BR000002',
        old_match_method: 'exact_squash',
        joined: false,
        stored: null,
        row_hash: null,
      },
    ]);
    expect(await makeReadMovedJoins(sql, 'uk_establishment_move')()).toEqual([
      {
        auditId: 501,
        newestAuditId: 501,
        organisationName: 'Westpac Banking Corporation',
        establishmentNumber: 'BR000106',
        method: 'exact',
        join: {
          stored,
          rowHash: 'hash of the join',
          companyNumber: 'BR000106',
          matchMethod: 'manual',
        },
      },
      {
        auditId: 502,
        newestAuditId: 640,
        organisationName: 'Gone Sponsor',
        establishmentNumber: 'BR000002',
        method: 'exact_squash',
        join: null,
      },
    ]);
    const text = flat(calls[0].text);
    expect(calls[0].params).toEqual(['uk_establishment_move']);
    expect(text).toContain(
      "WHERE a.changed_by = $1 AND a.new_match_method = 'manual' ORDER BY a.organisation_name, a.id DESC",
    );
    expect(text).toContain('SELECT DISTINCT ON (a.organisation_name)');
    expect(text).toContain(
      '(SELECT max(l.id) FROM hmrc_company_mapping_audit l WHERE l.organisation_name = a.organisation_name) AS newest_audit_id',
    );
  });
});

describe('makeCommitRestore', () => {
  test('one statement, bound to the join and the audit row the restore was planned on', async () => {
    const { sql, calls } = makeFakeSql([{ restored: 1 }]);
    expect(await makeCommitRestore(sql)(input)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([
      'exact',
      1,
      'Westpac Banking Corporation',
      'hash of the join',
      'Westpac Banking Corporation',
      501,
      'exact',
      'uk_establishment_method_restore',
    ]);
  });

  test('the method and score are written only on the join as read, with nothing recorded since the move', async () => {
    const { sql, calls } = makeFakeSql([{ restored: 1 }]);
    await makeCommitRestore(sql)(input);
    const text = flat(calls[0].text);
    expect(text).toContain(
      'UPDATE hmrc_company_mapping m SET match_method = $1, match_score = $2::numeric WHERE m.organisation_name = $3 AND md5(m::text) = $4 AND (SELECT max(l.id) FROM hmrc_company_mapping_audit l WHERE l.organisation_name = $5) = $6::int',
    );
    // The company number and the check time are not among what it sets.
    expect(text).not.toMatch(/SET[^W]*(company_number|verified_at)\s*=/);
  });

  test('its audit row is written from the join it wrote, naming the method it left and the one it took', async () => {
    const { sql, calls } = makeFakeSql([{ restored: 1 }]);
    await makeCommitRestore(sql)(input);
    expect(flat(calls[0].text)).toContain(
      "SELECT r.organisation_name, r.company_number, r.company_number, 'manual', $7, $8 FROM restored r",
    );
  });

  test.each([[[{ restored: 0 }]], [[]]])(
    'a join changed since it was read writes nothing: %j',
    async (rows) => {
      const { sql } = makeFakeSql(rows);
      expect(await makeCommitRestore(sql)(input)).toBe(false);
    },
  );
});
