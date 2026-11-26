/**
 * Database reads and the guarded write for giving moved joins their match
 * method back.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import type { CommitRestoreInput, MovedJoin } from './method-restore';

type Sql = NeonQueryFunction<false, false>;

type RawMoved = {
  audit_id: number;
  newest_audit_id: number;
  organisation_name: string;
  new_company_number: string | null;
  old_match_method: string | null;
  joined: boolean;
  stored: Record<string, unknown> | null;
  row_hash: string | null;
};

/** Read every join the given move stored as `manual`: its newest such audit row, beside the join as stored now. */
export function makeReadMovedJoins(sql: Sql, movedBy: string) {
  return async (): Promise<MovedJoin[]> => {
    // to_jsonb keeps each column as stored: a timestamp to the microsecond, in no time zone.
    const rows = (await sql`
      SELECT DISTINCT ON (a.organisation_name)
             a.id AS audit_id,
             (SELECT max(l.id) FROM hmrc_company_mapping_audit l
               WHERE l.organisation_name = a.organisation_name) AS newest_audit_id,
             a.organisation_name,
             a.new_company_number,
             a.old_match_method,
             (m.organisation_name IS NOT NULL) AS joined,
             to_jsonb(m) AS stored,
             md5(m::text) AS row_hash
      FROM hmrc_company_mapping_audit a
      LEFT JOIN hmrc_company_mapping m
        ON m.organisation_name = a.organisation_name
      WHERE a.changed_by = ${movedBy}
        AND a.new_match_method = 'manual'
      ORDER BY a.organisation_name, a.id DESC
    `) as RawMoved[];
    return rows.map((r) => ({
      auditId: Number(r.audit_id),
      newestAuditId: Number(r.newest_audit_id),
      organisationName: r.organisation_name,
      establishmentNumber: r.new_company_number,
      method: r.old_match_method,
      join:
        r.joined && r.stored && r.row_hash
          ? {
              stored: r.stored,
              rowHash: r.row_hash,
              companyNumber: (r.stored.company_number as string | null) ?? null,
              matchMethod: (r.stored.match_method as string | null) ?? null,
            }
          : null,
    }));
  };
}

/** Write one restore as a single statement: the join's method and score with its audit row, only while the join is as it was read and nothing has been recorded for the sponsor since the move. */
export function makeCommitRestore(sql: Sql) {
  return async (input: CommitRestoreInput): Promise<boolean> => {
    const rows = await sql`
      WITH restored AS (
        UPDATE hmrc_company_mapping m
        SET match_method = ${input.method},
            match_score  = ${input.score}::numeric
        WHERE m.organisation_name = ${input.organisationName}
          AND md5(m::text) = ${input.rowHash}
          AND (SELECT max(l.id) FROM hmrc_company_mapping_audit l
                WHERE l.organisation_name = ${input.organisationName})
            = ${input.auditId}::int
        RETURNING m.organisation_name, m.company_number
      ),
      audited AS (
        INSERT INTO hmrc_company_mapping_audit (
          organisation_name,
          old_company_number,
          new_company_number,
          old_match_method,
          new_match_method,
          changed_by
        )
        SELECT
          r.organisation_name,
          r.company_number,
          r.company_number,
          'manual',
          ${input.method},
          ${input.changedBy}
        FROM restored r
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM audited)::int AS restored
    `;
    return Number(rows[0]?.restored ?? 0) === 1;
  };
}
