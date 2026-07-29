/**
 * Normalises registry rows (CQC, Wikidata) into the {companyNumber, url} pairs
 * the website importer joins on. No I/O.
 *
 * Company numbers arrive in three shapes, all verified against prod data:
 * 8 digits (15,097 CQC rows), 2 letters + 6 alphanumerics (199 — SC/OC/NI, and
 * IP…R society numbers of which 25 join to real CH profiles), and 1-7 bare
 * digits with the leading zeros dropped (323 rows, which match nothing
 * unpadded and 120 once padded — so padding is not cosmetic).
 */

import { squashForComparison } from '../hmrc-ch/pipeline';

/** Post-padding shape of a Companies House number: 8 digits, or a 2-letter
 *  prefix followed by 6 alphanumerics (SC123456, OC123456, IP21143R). */
const COMPANY_NUMBER = /^(?:\d{8}|[A-Z]{2}[A-Z0-9]{6})$/;

/**
 * Canonicalise a registry-supplied company number, or null when it is not a
 * usable Companies House number.
 */
export function normaliseCompanyNumber(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, '').toUpperCase();
  if (!cleaned) return null;
  const padded = /^\d{1,7}$/.test(cleaned) ? cleaned.padStart(8, '0') : cleaned;
  return COMPANY_NUMBER.test(padded) ? padded : null;
}

/** Below this, the registry's name for a company and Companies House' name for
 *  it have too little in common to trust the identifier that linked them. */
const MIN_NAME_OVERLAP = 0.34;

/**
 * Sanity-check that a registry row's own company name is recognisably the
 * Companies House company it points at. Never the match — the join is always on
 * the number — and never a veto either: a false result downgrades the row to
 * `registry_unconfirmed` (candidate, not rendered) rather than dropping it.
 *
 * It exists because a mistyped charity number zero-pads into a structurally
 * valid but unrelated company number, which is invisible from the identifier
 * alone. It fires on 0.22% of CQC joins, and roughly half of those are correct
 * rows whose Companies House name changed after administration, so discarding
 * them would lose real data.
 */
export function namesAreCompatible(
  registryName: string | null | undefined,
  companyName: string | null | undefined,
): boolean {
  if (!registryName || !companyName) return true; // nothing to contradict
  const a = squashForComparison(registryName);
  const b = squashForComparison(companyName);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return true;
  let shared = 0;
  for (const g of left) if (right.has(g)) shared++;
  return shared / Math.min(left.size, right.size) >= MIN_NAME_OVERLAP;
}
