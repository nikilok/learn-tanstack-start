/**
 * Database wiring for the revalidation sweep: the factories that turn a Neon
 * client into the dependencies sweepWebsites asks for. All SQL for the sweep
 * lives here so the orchestrator stays testable without a database.
 */

import type { RevalidateResult } from './revalidate.ts';
import type { SweepRow } from './sweep.ts';

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

/**
 * One bounded slice, oldest-checked first.
 *
 * `checked_at ASC NULLS FIRST` makes a never-checked row sort ahead of every
 * checked one, so the first passes drain the backlog the importer created and
 * subsequent passes rotate through by age. The postcode comes from the profile
 * because it is the weaker corroboration when the number is absent; a company
 * we hold no address for simply skips that check.
 */
export function makeSelectRows(sql: Sql) {
  return async (maxRows: number): Promise<SweepRow[]> => {
    const rows = await sql`
      SELECT
        w.company_number,
        w.url,
        w.status,
        w.evidence,
        w.failure_count,
        (w.checked_at IS NOT NULL) AS ever_checked,
        p.postal_code
      FROM company_websites w
      LEFT JOIN companies_house_profiles p
        ON p.company_number = w.company_number
      WHERE w.url IS NOT NULL
      ORDER BY w.checked_at ASC NULLS FIRST
      LIMIT ${maxRows}
    `;
    return rows.map((r) => ({
      companyNumber: r.company_number as string,
      url: r.url as string,
      status: r.status as SweepRow['status'],
      evidence: r.evidence as SweepRow['evidence'],
      failureCount: Number(r.failure_count ?? 0),
      postcode: (r.postal_code as string | null) ?? null,
      everChecked: r.ever_checked === true,
    }));
  };
}

/**
 * Write one revalidation result.
 *
 * Liveness columns are written unconditionally — that is the sweep's own
 * subject and no other writer owns them. The identity columns are guarded so a
 * pass cannot undo an upgrade the monthly registry importer made between our
 * read and our write: `confidence` is the ladder's numeric proxy, so writing
 * evidence only when the stored confidence has not overtaken ours is the same
 * upgrade-only rule expressed in SQL, and GREATEST keeps the column monotonic.
 *
 * Postgres evaluates every SET expression against the pre-update row, so the
 * CASE and the GREATEST both see the old confidence rather than each other.
 */
export function makeApplyResult(sql: Sql) {
  return async (row: SweepRow, result: RevalidateResult): Promise<boolean> => {
    const updated = await sql`
      UPDATE company_websites SET
        url           = ${result.url},
        status        = ${result.status},
        failure_count = ${result.failureCount},
        checked_at    = now(),
        evidence      = CASE
          WHEN COALESCE(confidence, 0) <= ${result.confidence}::numeric
          THEN ${result.evidence} ELSE evidence END,
        evidence_url  = CASE
          WHEN COALESCE(confidence, 0) <= ${result.confidence}::numeric
          THEN ${result.evidenceUrl} ELSE evidence_url END,
        confidence    = GREATEST(COALESCE(confidence, 0), ${result.confidence}::numeric),
        verified_at   = CASE WHEN ${result.verified} THEN now() ELSE verified_at END
      WHERE company_number = ${row.companyNumber}
      RETURNING company_number
    `;
    return updated.length > 0;
  };
}

/** Real sleep, isolated so tests can inject an instant one. */
export function makeSleep() {
  return (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
}

/** Coverage counters for the run summary, including the renderable figure that
 *  is the whole point of the sweep. */
export function makeCoverage(sql: Sql) {
  return async () => {
    const rows = await sql`
      WITH mapped AS (
        SELECT DISTINCT company_number AS cn FROM hmrc_company_mapping
        WHERE company_number IS NOT NULL
      )
      SELECT
        (SELECT count(*) FROM mapped)::int AS sponsors,
        (SELECT count(*) FROM company_websites w JOIN mapped ON mapped.cn = w.company_number
          WHERE w.status = 'verified')::int AS identified,
        (SELECT count(*) FROM company_websites w JOIN mapped ON mapped.cn = w.company_number
          WHERE w.status = 'verified' AND w.checked_at IS NOT NULL)::int AS renderable,
        (SELECT count(*) FROM company_websites WHERE status = 'dead')::int AS dead_total,
        (SELECT count(*) FROM company_websites WHERE checked_at IS NULL)::int AS never_checked
    `;
    const r = rows[0];
    return {
      sponsors: Number(r.sponsors),
      identified: Number(r.identified),
      renderable: Number(r.renderable),
      deadTotal: Number(r.dead_total),
      neverChecked: Number(r.never_checked),
    };
  };
}
