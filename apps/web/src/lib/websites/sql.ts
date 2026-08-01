/**
 * Database wiring for the revalidation sweep: the factories that turn a Neon
 * client into the dependencies sweepWebsites asks for. All SQL for the sweep
 * lives here so the orchestrator stays testable without a database.
 */

import type { RevalidateResult } from './revalidate.ts';
import { mergeRevalidation } from './revalidate.ts';
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
        w.evidence_url,
        w.confidence,
        coalesce(p.company_name, '') AS company_name,
        -- "Have we ever completed a SUCCESSFUL pass", not "is checked_at set".
        -- checked_at is stamped on failures too, so keying off it alone meant a
        -- row whose first night timed out was excluded from disclosure probing
        -- forever, having never actually been probed once.
        (w.checked_at IS NOT NULL
          AND w.status NOT IN ('pending', 'unreachable', 'dead')) AS ever_checked,
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
      companyName: (r.company_name as string | null) ?? '',
      url: r.url as string,
      status: r.status as SweepRow['status'],
      evidence: r.evidence as SweepRow['evidence'],
      failureCount: Number(r.failure_count ?? 0),
      postcode: (r.postal_code as string | null) ?? null,
      everChecked: r.ever_checked === true,
      evidenceUrl: (r.evidence_url as string | null) ?? null,
      confidence: (r.confidence as string | null) ?? null,
    }));
  };
}

/**
 * Write one revalidation result.
 *
 * Deliberately does no reasoning. Every column is a plain assignment of a value
 * mergeRevalidation already decided, and concurrency is handled by an
 * optimistic lock rather than by conditional writes.
 *
 * The previous shape put that reasoning in SQL `CASE` expressions, and three
 * separate defects settled there across two review rounds — each one a column
 * written when it should have been left alone. None was catchable by a test,
 * because none of it was reachable without a database. Keeping this statement
 * dumb is what makes the rules testable.
 */
export function makeApplyResult(sql: Sql) {
  return async (row: SweepRow, result: RevalidateResult): Promise<boolean> => {
    const next = mergeRevalidation(
      {
        url: row.url,
        evidence: row.evidence,
        evidenceUrl: row.evidenceUrl,
        confidence: row.confidence,
      },
      result,
    );
    const updated = await sql`
      UPDATE company_websites SET
        url           = ${next.url},
        status        = ${next.status},
        evidence      = ${next.evidence},
        evidence_url  = ${next.evidenceUrl},
        confidence    = ${next.confidence}::numeric,
        failure_count = ${next.failureCount},
        checked_at    = now(),
        verified_at   = CASE WHEN ${next.bumpVerifiedAt} THEN now() ELSE verified_at END
      WHERE company_number = ${row.companyNumber}
        -- Full optimistic lock on every identity column we read, not just the
        -- URL. A slice runs for up to two hours and the registry importer can
        -- change any of them in that window — including upgrading evidence on
        -- an unchanged URL, which a url-only lock waved through and which let
        -- the sweep write back a stale tier. Anything moved under us and this
        -- writes nothing, which surfaces as lock_missed and the next pass picks
        -- the row up with fresh values.
        --
        -- This is also why there are no CASE expressions left here: the whole
        -- reconciliation is mergeRevalidation's, where it is testable.
        AND url = ${row.url}
        AND evidence = ${row.evidence}
        AND confidence IS NOT DISTINCT FROM ${row.confidence}::numeric
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
