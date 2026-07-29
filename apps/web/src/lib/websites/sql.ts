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
        -- A failure verdict is the sweep's own and is written outright. A
        -- success-derived status is computed from the evidence we READ, and the
        -- registry importer can upgrade evidence on the same URL in the two
        -- hours a slice runs — which the url lock does not catch. Guarding it
        -- with the same confidence comparison stops the sweep writing back a
        -- stale lower tier and un-rendering a row the importer just promoted.
        status        = CASE
          WHEN ${result.live} AND COALESCE(confidence, 0) > ${result.confidence}::numeric
          THEN status ELSE ${result.status} END,
        failure_count = ${result.failureCount},
        checked_at    = now(),
        evidence      = CASE
          WHEN COALESCE(confidence, 0) <= ${result.confidence}::numeric
          THEN ${result.evidence} ELSE evidence END,
        -- COALESCE, not a bare assignment: a pass that finds no proof returns
        -- evidenceUrl null at unchanged confidence, so the CASE alone wiped the
        -- stored proof page on the very next run. Disclosure probing is
        -- first-pass-only, so once wiped it could never be rebuilt.
        evidence_url  = CASE
          WHEN COALESCE(confidence, 0) <= ${result.confidence}::numeric
          THEN COALESCE(${result.evidenceUrl}, evidence_url) ELSE evidence_url END,
        confidence    = GREATEST(COALESCE(confidence, 0), ${result.confidence}::numeric),
        verified_at   = CASE WHEN ${result.verified} THEN now() ELSE verified_at END
      WHERE company_number = ${row.companyNumber}
        -- Optimistic lock on the URL we actually validated. A slice runs for up
        -- to two hours; if the importer swapped the URL in that window our
        -- liveness verdict describes a page that is no longer this row's, and
        -- writing checked_at would mark the new URL renderable without anyone
        -- having fetched it. Skipping here shows up as lock_missed and the next
        -- pass picks the row up.
        AND url = ${row.url}
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
