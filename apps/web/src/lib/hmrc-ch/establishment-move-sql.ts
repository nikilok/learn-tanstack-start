/**
 * Database reads and the guarded write for moving an overseas company's joins
 * onto its UK establishment.
 */

import type { NeonQueryFunction } from '@ss/db/client';

import type {
  CommitMoveInput,
  CommitMoveResult,
  EstablishmentMove,
  MoveState,
  StoredRow,
} from './establishment-move';

type Sql = NeonQueryFunction<false, false>;

type RawStored = { stored: Record<string, unknown>; row_hash: string };

/** Stored rows grouped by the company number each holds, in the order read. */
function byCompany(rows: RawStored[]): Map<string, StoredRow[]> {
  const grouped = new Map<string, StoredRow[]>();
  for (const { stored, row_hash } of rows) {
    const companyNumber = stored.company_number as string;
    const held = grouped.get(companyNumber) ?? [];
    held.push({ stored, rowHash: row_hash });
    grouped.set(companyNumber, held);
  }
  return grouped;
}

/** Every company a sponsor is joined to that the register types as an overseas company. */
export function makeReadOverseasCompanies(sql: Sql) {
  return async (): Promise<string[]> => {
    const rows = await sql`
      SELECT DISTINCT m.company_number
      FROM hmrc_company_mapping m
      JOIN companies_house_profiles p ON p.company_number = m.company_number
      WHERE p.company_type = 'oversea-company'
      ORDER BY m.company_number
    `;
    return rows.map((r) => r.company_number as string);
  };
}

/** Read what the database holds for each listed move, keyed by its overseas company. */
export function makeReadMoveStates(sql: Sql) {
  return async (
    entries: readonly EstablishmentMove[],
  ): Promise<Map<string, MoveState>> => {
    const numbers = entries.flatMap((e) => [
      e.companyNumber,
      e.establishmentNumber,
    ]);
    // to_jsonb keeps each column as stored: a timestamp to the microsecond, in no time zone.
    const joins = byCompany(
      (await sql`
        SELECT to_jsonb(m) AS stored, md5(m::text) AS row_hash
        FROM hmrc_company_mapping m
        WHERE m.company_number = ANY(${numbers}::text[])
      `) as RawStored[],
    );
    const sites = byCompany(
      (await sql`
        SELECT to_jsonb(w) AS stored, md5(w::text) AS row_hash
        FROM company_websites w
        WHERE w.company_number = ANY(${numbers}::text[])
      `) as RawStored[],
    );
    const answers = byCompany(
      (await sql`
        SELECT to_jsonb(a) AS stored, md5(a::text) AS row_hash
        FROM company_answers a
        WHERE a.company_number = ANY(${numbers}::text[])
        ORDER BY a.id
      `) as RawStored[],
    );
    return new Map(
      entries.map(({ companyNumber, establishmentNumber }) => [
        companyNumber,
        {
          joins: (joins.get(companyNumber) ?? []).map((row) => ({
            ...row,
            organisationName: row.stored.organisation_name as string,
            matchMethod: (row.stored.match_method as string | null) ?? null,
          })),
          movedJoins: joins.get(establishmentNumber)?.length ?? 0,
          site: sites.get(companyNumber)?.[0] ?? null,
          establishmentHasSite: sites.has(establishmentNumber),
          answers: (answers.get(companyNumber) ?? []).map((row) => ({
            ...row,
            id: Number(row.stored.id),
          })),
          establishmentAnswers: answers.get(establishmentNumber)?.length ?? 0,
        },
      ]),
    );
  };
}

/** Write one move as a single statement: the joins with their audit rows, the website row and the answers. It locks every row it moves, reads them again, and writes only when each is as the move was planned on. A join stored as `manual` loses its score and is stamped; one that keeps its method changes in its company number alone. */
export function makeCommitMove(sql: Sql) {
  return async (input: CommitMoveInput): Promise<CommitMoveResult | null> => {
    const names = input.joins.map((join) => join.organisationName);
    const hashes = input.joins.map((join) => join.rowHash);
    const answerIds = input.answers.map((answer) => answer.id);
    const answerHashes = input.answers.map((answer) => answer.rowHash);
    const rows = await sql`
      WITH expected AS (
        SELECT * FROM unnest(${names}::text[], ${hashes}::text[])
          AS e(organisation_name, row_hash)
      ),
      expected_answers AS (
        SELECT * FROM unnest(${answerIds}::int[], ${answerHashes}::text[])
          AS x(id, row_hash)
      ),
      joins AS MATERIALIZED (
        SELECT m.organisation_name, m.company_number, m.match_method,
               md5(m::text) AS row_hash
        FROM hmrc_company_mapping m
        WHERE m.company_number = ${input.companyNumber}
        FOR UPDATE
      ),
      site_row AS MATERIALIZED (
        SELECT md5(w::text) AS row_hash
        FROM company_websites w
        WHERE w.company_number = ${input.companyNumber}
        FOR UPDATE
      ),
      answer_rows AS MATERIALIZED (
        SELECT a.id, md5(a::text) AS row_hash
        FROM company_answers a
        WHERE a.company_number = ${input.companyNumber}
        FOR UPDATE
      ),
      intact AS (
        SELECT (
          (SELECT count(*) FROM joins j
             JOIN expected e ON e.organisation_name = j.organisation_name
                            AND e.row_hash = j.row_hash)
            = (SELECT count(*) FROM expected)
          AND (SELECT count(*) FROM joins) = (SELECT count(*) FROM expected)
          AND (SELECT s.row_hash FROM site_row s)
            IS NOT DISTINCT FROM ${input.siteHash}::text
          AND (${input.siteHash}::text IS NULL OR NOT EXISTS (
                SELECT 1 FROM company_websites w
                WHERE w.company_number = ${input.establishmentNumber}))
          AND (SELECT count(*) FROM answer_rows r
                 JOIN expected_answers x ON x.id = r.id
                                        AND x.row_hash = r.row_hash)
            = (SELECT count(*) FROM expected_answers)
          AND (SELECT count(*) FROM answer_rows)
            = (SELECT count(*) FROM expected_answers)
          AND (NOT EXISTS (SELECT 1 FROM expected_answers) OR NOT EXISTS (
                SELECT 1 FROM company_answers a
                WHERE a.company_number = ${input.establishmentNumber}))
        ) AS ok
      ),
      mode AS (
        SELECT ${input.storage === 'kept'}::boolean AS keep
      ),
      moved AS (
        UPDATE hmrc_company_mapping m
        SET company_number = ${input.establishmentNumber},
            match_method   = CASE WHEN (SELECT keep FROM mode)
                                  THEN m.match_method ELSE 'manual' END,
            match_score    = CASE WHEN (SELECT keep FROM mode)
                                  THEN m.match_score END,
            verified_at    = CASE WHEN (SELECT keep FROM mode)
                                  THEN m.verified_at ELSE now() END
        FROM joins j
        WHERE m.organisation_name = j.organisation_name
          AND (SELECT ok FROM intact)
        RETURNING m.organisation_name
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
          j.organisation_name,
          j.company_number,
          ${input.establishmentNumber},
          j.match_method,
          CASE WHEN (SELECT keep FROM mode) THEN j.match_method ELSE 'manual' END,
          ${input.changedBy}
        FROM joins j
        JOIN moved USING (organisation_name)
        RETURNING 1
      ),
      site AS (
        UPDATE company_websites w
        SET company_number = ${input.establishmentNumber}
        WHERE w.company_number = ${input.companyNumber}
          AND (SELECT ok FROM intact)
        RETURNING 1
      ),
      answers AS (
        UPDATE company_answers a
        SET company_number = ${input.establishmentNumber}
        WHERE a.company_number = ${input.companyNumber}
          AND (SELECT ok FROM intact)
        RETURNING 1
      )
      SELECT (SELECT ok FROM intact) AS ok,
             (SELECT count(*) FROM audited)::int AS joins,
             (SELECT count(*) FROM site)::int AS sites,
             (SELECT count(*) FROM answers)::int AS answers
    `;
    const row = rows[0];
    if (row?.ok !== true) return null;
    return {
      joins: Number(row.joins),
      sites: Number(row.sites),
      answers: Number(row.answers),
    };
  };
}
