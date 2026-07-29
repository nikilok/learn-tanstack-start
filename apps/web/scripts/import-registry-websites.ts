/**
 * Registry website importer — the exact-identifier tier of company website
 * discovery.
 *
 * Joins two public registers to companies_house_profiles on the company number
 * and writes the result to company_websites. No search engine, no LLM, no page
 * fetching: every row here is an exact-ID join, which is what makes it the
 * cheapest verified coverage available and the labelled set the search tier is
 * later measured against.
 *
 *   CQC      — the provider directory is the only CQC file carrying both a
 *              Companies House number and a web address, and it is published as
 *              .ods only (23MB archive, ~439MB of XML) on a URL that rotates
 *              monthly, so the URL is discovered rather than constructed.
 *   Wikidata — P2622 (Companies House company ID) + P856 (official website),
 *              one SPARQL request. Small, but it covers the globally-branded
 *              subsidiaries that carry no UK company number on their homepage.
 *
 * Deliberately does NOT set checked_at, for two reasons. It is the phase-2
 * sweep's cursor, so stamping it here would push these companies to the back of
 * the queue that is meant to verify them. And it is half the render gate:
 * `verified` means the company-number join is sound, not that the URL still
 * resolves, and only 74% of these do (measured over 150, 2026-07-29). Leaving
 * checked_at NULL is what stops an unfetched registry URL reaching a page.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/import-registry-websites.ts --dry-run
 *   bun apps/web/scripts/import-registry-websites.ts --source=wikidata
 *   bun apps/web/scripts/import-registry-websites.ts --cqc-file=/tmp/cqc.ods
 *   bun apps/web/scripts/import-registry-websites.ts            # full run (CI)
 *
 * Env: POSTGRES_URL.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { neon } from '@ss/db/client';
import { companyWebsites } from '@ss/db/schema';
import { sql as raw } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

import { describeDbHost } from '../src/lib/phase5/db-host.ts';
import type {
  WebsiteEvidence,
  WebsiteStatus,
} from '../src/lib/websites/decide.ts';
import {
  decideWebsite,
  evidenceConfidence,
  statusForEvidence,
} from '../src/lib/websites/decide.ts';
import { normaliseWebsiteUrl } from '../src/lib/websites/normalise-url.ts';
import {
  namesAreCompatible,
  normaliseCompanyNumber,
} from '../src/lib/websites/registry-rows.ts';
import { setGitHubOutput } from './ci-utils.ts';
import { readOdsRows } from './lib/ods-table.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CQC_DATA_PAGE =
  'https://www.cqc.org.uk/about-us/transparency/using-cqc-data';
/** The care directory with filters. Its URL carries the publication date, so it
 *  is scraped from the index page rather than constructed. */
const CQC_ODS_LINK =
  /https:\/\/www\.cqc\.org\.uk\/sites\/default\/files\/[0-9]{4}-[0-9]{2}\/[^"'\s]*HSCA_Active_Locations\.ods/g;

const CQC_COLUMN_CRN = 'Provider Companies House Number';
const CQC_COLUMN_WEB = 'Provider Web Address';
const CQC_COLUMN_NAME = 'Provider Name';

const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_QUERY = `SELECT ?crn ?site ?itemLabel WHERE {
  ?item wdt:P2622 ?crn .
  ?item wdt:P856 ?site .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
/** Wikidata blocks unidentified clients; this is the contact they ask for. */
const USER_AGENT =
  'SponsorSearch-registry-import/1.0 (https://sponsorsearch.co.uk)';

const BATCH_SIZE = 500;
/** A registry that has lost most of its usable rows is a format change, not a
 *  quiet month — below this share of the last known good count, fail loudly.
 *  CQC yielded 15,689 pairs on 2026-07-29. */
const MIN_CQC_PAIRS = 8000;
/** Registry rows matching a company we hold, PER SOURCE, so a single-source run
 *  is measured against what that source alone can deliver. A combined floor
 *  applied to `--source=wikidata` (an exposed workflow_dispatch choice) fails
 *  every time and trains the operator to ignore a guard that is meant to catch
 *  a repurposed company-number column. Measured 2026-07-29: CQC 5,617,
 *  Wikidata 1,132. */
const MIN_MATCHED_COMPANIES: Record<RegistrySource, number> = {
  cqc: 2000,
  wikidata: 400,
};

type RegistrySource = 'cqc' | 'wikidata';

type Finding = {
  companyNumber: string;
  url: string;
  registryName: string;
  source: RegistrySource;
};

// ─────────────────────────────────────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cqcFileArg = args.find((a) => a.startsWith('--cqc-file='))?.split('=')[1];
const sourceArg = args.find((a) => a.startsWith('--source='))?.split('=')[1];
const sources: RegistrySource[] =
  sourceArg === 'cqc'
    ? ['cqc']
    : sourceArg === 'wikidata'
      ? ['wikidata']
      : ['cqc', 'wikidata'];
if (sourceArg && !['cqc', 'wikidata', 'all'].includes(sourceArg)) {
  console.error(`Unknown --source="${sourceArg}" (cqc | wikidata | all)`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the current care-directory .ods URL from the CQC index page. */
async function discoverCqcOdsUrl(): Promise<string> {
  const res = await fetch(CQC_DATA_PAGE, {
    headers: { 'user-agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`CQC index page returned ${res.status}`);
  }
  const html = await res.text();
  const matches = [...new Set(html.match(CQC_ODS_LINK) ?? [])];
  if (matches.length === 0) {
    throw new Error(
      `No HSCA_Active_Locations.ods link on ${CQC_DATA_PAGE} — the page layout or file name changed`,
    );
  }
  // Newest first: the date is in the path, so a lexical sort is chronological.
  return matches.sort().reverse()[0];
}

async function readCqc(workDir: string): Promise<Finding[]> {
  let odsPath = cqcFileArg;
  if (!odsPath) {
    const url = await discoverCqcOdsUrl();
    console.log(`  source: ${url}`);
    odsPath = join(workDir, 'cqc-active-locations.ods');
    // curl, not fetch: streams to disk with retries, as bulk-snapshot-match.ts.
    const dl = Bun.spawnSync([
      'curl',
      '-fsSL',
      '--retry',
      '3',
      '-o',
      odsPath,
      url,
    ]);
    if (dl.exitCode !== 0) {
      throw new Error(`CQC download failed (curl exit ${dl.exitCode})`);
    }
  }

  const findings = new Map<string, Finding>();
  let rows = 0;
  for await (const row of readOdsRows(odsPath, {
    requiredColumns: [CQC_COLUMN_CRN, CQC_COLUMN_WEB, CQC_COLUMN_NAME],
  })) {
    rows++;
    const companyNumber = normaliseCompanyNumber(row[CQC_COLUMN_CRN]);
    const url = normaliseWebsiteUrl(row[CQC_COLUMN_WEB]);
    if (!companyNumber || !url) continue;
    // One provider owns many locations; first wins, they carry the same site.
    if (!findings.has(companyNumber)) {
      findings.set(companyNumber, {
        companyNumber,
        url,
        registryName: row[CQC_COLUMN_NAME] ?? '',
        source: 'cqc',
      });
    }
  }

  console.log(`  parsed ${rows} rows → ${findings.size} company/site pairs`);
  if (findings.size < MIN_CQC_PAIRS) {
    throw new Error(
      `CQC yielded only ${findings.size} pairs (expected >= ${MIN_CQC_PAIRS}) — column names or file format changed`,
    );
  }
  return [...findings.values()];
}

async function readWikidata(): Promise<Finding[]> {
  const url = `${WIKIDATA_ENDPOINT}?query=${encodeURIComponent(WIKIDATA_QUERY)}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/sparql-results+json',
      'user-agent': USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL returned ${res.status}`);
  const body = (await res.json()) as {
    results: {
      bindings: {
        crn: { value: string };
        site: { value: string };
        itemLabel?: { value: string };
      }[];
    };
  };

  const findings = new Map<string, Finding>();
  for (const b of body.results.bindings) {
    const companyNumber = normaliseCompanyNumber(b.crn.value);
    const url = normaliseWebsiteUrl(b.site.value);
    if (!companyNumber || !url) continue;
    // An item can carry several official sites (regional editions of one
    // publisher, say). The shortest is the canonical one in every observed case.
    const existing = findings.get(companyNumber);
    if (existing && existing.url.length <= url.length) continue;
    findings.set(companyNumber, {
      companyNumber,
      url,
      registryName: b.itemLabel?.value ?? '',
      source: 'wikidata',
    });
  }

  console.log(
    `  parsed ${body.results.bindings.length} statements → ${findings.size} company/site pairs`,
  );
  return [...findings.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// DB wiring
// ─────────────────────────────────────────────────────────────────────────────

const sql = neon(process.env.POSTGRES_URL as string);
const db = drizzle({ client: sql });

type KnownCompany = { companyNumber: string; companyName: string };
type ExistingRow = {
  companyNumber: string;
  url: string | null;
  status: string;
  evidence: string;
  source: string | null;
};

async function loadKnownCompanies(
  numbers: string[],
): Promise<Map<string, KnownCompany>> {
  const out = new Map<string, KnownCompany>();
  for (let i = 0; i < numbers.length; i += 5000) {
    const slice = numbers.slice(i, i + 5000);
    const rows = (await sql`
      SELECT company_number, company_name
      FROM companies_house_profiles
      WHERE company_number = ANY(${slice}::text[])
    `) as { company_number: string; company_name: string }[];
    for (const r of rows) {
      out.set(r.company_number, {
        companyNumber: r.company_number,
        companyName: r.company_name,
      });
    }
  }
  return out;
}

async function loadExisting(
  numbers: string[],
): Promise<Map<string, ExistingRow>> {
  const out = new Map<string, ExistingRow>();
  for (let i = 0; i < numbers.length; i += 5000) {
    const slice = numbers.slice(i, i + 5000);
    const rows = (await sql`
      SELECT company_number, url, status, evidence, source
      FROM company_websites
      WHERE company_number = ANY(${slice}::text[])
    `) as {
      company_number: string;
      url: string | null;
      status: string;
      evidence: string;
      source: string | null;
    }[];
    for (const r of rows) {
      out.set(r.company_number, {
        companyNumber: r.company_number,
        url: r.url,
        status: r.status,
        evidence: r.evidence,
        source: r.source,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
console.log(
  `Registry website import — db ${describeDbHost(process.env.POSTGRES_URL)}${dryRun ? ' (DRY RUN)' : ''}`,
);
console.log(`  sources: ${sources.join(', ')}`);

const workDir = mkdtempSync(join(tmpdir(), 'registry-websites-'));
let findings: Finding[] = [];
let errored = 0;

try {
  for (const source of sources) {
    console.log(`\n[${source}]`);
    try {
      const rows =
        source === 'cqc' ? await readCqc(workDir) : await readWikidata();
      findings = findings.concat(rows);
    } catch (err) {
      errored++;
      console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (errored === sources.length) {
  console.error('\nEvery source failed — nothing to import.');
  process.exit(1);
}

// Strongest source first so a company present in both is decided by evidence,
// not by array order (CQC and Wikidata overlap on ~23 companies).
findings.sort((a, b) =>
  a.source === b.source ? 0 : a.source === 'cqc' ? -1 : 1,
);

const numbers = [...new Set(findings.map((f) => f.companyNumber))];
console.log(`\nResolving ${numbers.length} distinct company numbers …`);
const known = await loadKnownCompanies(numbers);
const existing = await loadExisting(numbers);
console.log(
  `  ${known.size} are companies we hold a Companies House profile for`,
);

type PendingWrite = {
  companyNumber: string;
  url: string;
  status: string;
  evidence: WebsiteEvidence;
  confidence: string;
  source: RegistrySource;
  verifiedAt: Date | null;
};

const writes = new Map<string, PendingWrite>();
const now = new Date();
let unknownCompany = 0;
let kept = 0;
let conflicts = 0;
let unconfirmed = 0;

for (const finding of findings) {
  const company = known.get(finding.companyNumber);
  if (!company) {
    unknownCompany++;
    continue;
  }

  // The join is on the number; the name only decides how far up the ladder the
  // row lands. A mismatch is usually a post-administration rename, so it stays
  // as a candidate rather than being discarded.
  //
  // Only CQC is scored this way. The check compares a registry's name for a
  // company against its registered name, which holds for CQC (Provider Name IS
  // the registered name) but not for Wikidata, whose itemLabel is the brand:
  // 'BBC' vs 'BRITISH BROADCASTING CORPORATION' and 'Bupa' vs 'THE BRITISH
  // UNITED PROVIDENT ASSOCIATION LIMITED' both score zero overlap. Measured on
  // the first live run it demoted 6.2% of Wikidata rows against 0.23% of CQC's
  // — and Wikidata is in this pipeline precisely for globally-branded
  // companies, so the check was rejecting the population it was added to cover.
  const nameChecked = finding.source === 'cqc';
  const compatible =
    !nameChecked ||
    namesAreCompatible(finding.registryName, company.companyName);
  const evidence: WebsiteEvidence = compatible
    ? 'registry'
    : 'registry_unconfirmed';
  if (!compatible) unconfirmed++;

  const prior =
    writes.get(finding.companyNumber) ?? existing.get(finding.companyNumber);
  const decision = decideWebsite(
    prior
      ? {
          url: prior.url,
          status: prior.status as WebsiteStatus,
          evidence: prior.evidence as WebsiteEvidence,
          source: prior.source,
        }
      : null,
    { url: finding.url, evidence, source: finding.source },
  );

  if (decision.action === 'keep') {
    kept++;
    continue;
  }
  if (decision.action === 'conflict') {
    conflicts++;
    console.log(
      `  conflict ${finding.companyNumber}: kept ${prior?.url} over ${finding.source}'s ${finding.url}`,
    );
    continue;
  }

  const status = statusForEvidence(evidence);
  writes.set(finding.companyNumber, {
    companyNumber: finding.companyNumber,
    url: finding.url,
    status,
    evidence,
    confidence: evidenceConfidence(evidence).toFixed(3),
    source: finding.source,
    verifiedAt: status === 'verified' ? now : null,
  });
}

const pending = [...writes.values()];
console.log(
  `\n${pending.length} rows to write (${kept} unchanged, ${conflicts} conflicts)`,
);

// Checked BEFORE the upsert, not after: this guard exists to catch a registry
// repurposing its company-number column, and zero-padding turns such values
// into structurally valid numbers that collide with real companies. Running it
// after the write diagnoses the problem correctly but the wrong rows are
// already committed, and the upgrade-only ladder then reads a later correct
// run as an equal-rank conflict, so they would never be corrected.
const matchedFloor = sources.reduce(
  (total, source) => total + MIN_MATCHED_COMPANIES[source],
  0,
);
if (known.size < matchedFloor) {
  console.error(
    `\n  Only ${known.size} registry rows matched a known company (expected >= ${matchedFloor} for ${sources.join('+')}) — check the company-number column. Nothing was written.`,
  );
  process.exit(1);
}

let written = 0;
if (!dryRun && pending.length > 0) {
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const applied = await db
      .insert(companyWebsites)
      .values(batch)
      .onConflictDoUpdate({
        target: companyWebsites.companyNumber,
        set: {
          url: raw`excluded.url`,
          status: raw`excluded.status`,
          evidence: raw`excluded.evidence`,
          confidence: raw`excluded.confidence`,
          source: raw`excluded.source`,
          verifiedAt: raw`excluded.verified_at`,
          // Liveness belongs to the URL, not the row. When the URL changes,
          // the previous one's verification state is meaningless — carrying a
          // checked_at over would let a never-fetched address satisfy the
          // render gate (`verified AND checked_at IS NOT NULL`) immediately,
          // and sort the row to the back of the sweep cursor so nothing
          // revisits it. Only ~74% of registry URLs resolve, so that is a live
          // broken link, not a theoretical one.
          checkedAt: raw`CASE WHEN company_websites.url IS DISTINCT FROM excluded.url THEN NULL ELSE company_websites.checked_at END`,
          failureCount: raw`CASE WHEN company_websites.url IS DISTINCT FROM excluded.url THEN 0 ELSE company_websites.failure_count END`,
          evidenceUrl: raw`CASE WHEN company_websites.url IS DISTINCT FROM excluded.url THEN NULL ELSE company_websites.evidence_url END`,
        },
        // Upgrade-only in SQL as well as in decideWebsite, so a concurrent
        // writer (the phase-2 sweep) cannot be clobbered between our read and
        // our write. confidence is the ladder's numeric proxy. `manual` is
        // named explicitly rather than relying on its confidence of 1.0: the
        // column is nullable, so an owner-set row written without one would
        // otherwise be overwritten by the IS NULL disjunct.
        setWhere: raw`company_websites.evidence <> 'manual' AND (company_websites.confidence IS NULL OR company_websites.confidence < excluded.confidence)`,
      })
      .returning({ companyNumber: companyWebsites.companyNumber });
    // Count what the guard actually applied, not what we submitted — a no-op
    // from setWhere is the only signal the upgrade guard ever rejects anything.
    written += applied.length;
  }
}
if (!dryRun && written < pending.length) {
  console.log(
    `  ${pending.length - written} row(s) were rejected by the upgrade guard (a stronger writer got there first)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const coverage = (await sql`
  WITH mapped AS (
    SELECT DISTINCT company_number AS cn FROM hmrc_company_mapping
    WHERE company_number IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM mapped)::int AS sponsors,
    (SELECT count(*) FROM company_websites w JOIN mapped ON mapped.cn = w.company_number
      WHERE w.status = 'verified')::int AS verified_sponsors,
    -- The render gate is status=verified AND checked_at IS NOT NULL (schema.ts),
    -- and this importer deliberately leaves checked_at NULL, so reporting only
    -- the line above would show growing coverage while nothing is renderable.
    (SELECT count(*) FROM company_websites w JOIN mapped ON mapped.cn = w.company_number
      WHERE w.status = 'verified' AND w.checked_at IS NOT NULL)::int AS renderable_sponsors,
    (SELECT count(*) FROM company_websites WHERE status = 'verified')::int AS verified_total,
    (SELECT count(*) FROM company_websites WHERE status = 'candidate')::int AS candidate_total
`) as {
  sponsors: number;
  verified_sponsors: number;
  renderable_sponsors: number;
  verified_total: number;
  candidate_total: number;
}[];
const c = coverage[0];
const durationSec = Math.round((Date.now() - startedAt) / 1000);

// Keys stay stable between dry and live runs — the workflow's step summary
// greps these labels, so a mode-dependent label would silently blank a row.
console.log('\n─── summary ───');
console.log(`  findings            : ${findings.length}`);
console.log(`  unknown_company     : ${unknownCompany}`);
console.log(`  name_unconfirmed    : ${unconfirmed}`);
console.log(`  unchanged           : ${kept}`);
console.log(`  conflicts           : ${conflicts}`);
console.log(`  would_write         : ${pending.length}`);
console.log(`  written             : ${written}`);
console.log(`  verified_total      : ${c.verified_total}`);
console.log(`  candidate_total     : ${c.candidate_total}`);
console.log(
  `  sponsor_identified  : ${c.verified_sponsors}/${c.sponsors} (${((c.verified_sponsors / c.sponsors) * 100).toFixed(2)}%)`,
);
console.log(
  `  sponsor_renderable  : ${c.renderable_sponsors}/${c.sponsors} (${((c.renderable_sponsors / c.sponsors) * 100).toFixed(2)}%)`,
);
console.log(`  duration            : ${durationSec}s`);

setGitHubOutput('verified-sponsors', String(c.verified_sponsors));
setGitHubOutput('renderable-sponsors', String(c.renderable_sponsors));
setGitHubOutput('written', String(dryRun ? 0 : written));

// Loud failure, same posture as the sweeps: one source dying is survivable and
// visible in the log, but it must not pass silently as a healthy run.
if (errored > 0) {
  console.error(`\n  ${errored} of ${sources.length} sources failed.`);
  process.exit(1);
}
// Note there is deliberately no alarm on the unknown_company rate: it is the
// NORMAL state, because both registries cover the whole UK while
// companies_house_profiles only holds companies that sponsor visas, so ~2/3 of
// rows legitimately match nothing (13,245 of 20,019 on 2026-07-29). The
// meaningful invariant is the matched-company floor, and it is enforced above,
// before anything is written.
