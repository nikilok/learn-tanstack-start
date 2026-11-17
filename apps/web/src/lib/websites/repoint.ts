/**
 * An owner's repoint: a row moved to the address the owner chose, or pinned
 * where it already is, so no later import moves it. The list is checked and
 * each row's change decided here. No I/O.
 */

import {
  statusForEvidence,
  type WebsiteEvidence,
  type WebsiteStatus,
} from './decide';
import { normaliseWebsiteUrl, siteOf } from './normalise-url';
import { isAggregatorHost } from './page-signals';

/** One repoint, as the owner lists it. */
export type RepointEntry = {
  companyNumber: string;
  /** The address the row holds now. */
  url: string;
  /** The address the owner chose; the same one pins the row where it is. */
  newUrl: string;
  /** The page of the new site its proof is on, when there is one. */
  newEvidenceUrl: string | null;
  /** The owner read the new address and it carries the proof: the row keeps the last check it has, so one that renders goes on rendering. It never stamps a check: a row the sweep has not read waits for it either way. */
  keepLive: boolean;
};

/** What a repoint writes to one row: its pin alone, or a move to the new address. */
export type Repoint =
  | { kind: 'pin' }
  | {
      kind: 'move';
      url: string;
      evidenceUrl: string | null;
      status: WebsiteStatus;
      keepLive: boolean;
    };

/** The fields of a stored row a repoint is decided on. */
type RepointRow = {
  url: string | null;
  evidence: WebsiteEvidence;
  pinned: boolean;
};

/**
 * What a repoint does to a row as it reads now: `already` when it is pinned
 * on the new address, `differs` when it holds neither address, which means
 * the list is out of date. Addresses are compared exactly as stored.
 */
export function repointRow(
  row: RepointRow,
  entry: RepointEntry,
): Repoint | 'already' | 'differs' {
  if (row.url === entry.newUrl) return row.pinned ? 'already' : { kind: 'pin' };
  if (row.url !== entry.url) return 'differs';
  return {
    kind: 'move',
    url: entry.newUrl,
    evidenceUrl: entry.newEvidenceUrl,
    // What the sweep found at the old address says nothing of the new one.
    status: statusForEvidence(row.evidence),
    keepLive: entry.keepLive,
  };
}

/** The site a web address is on, compared www-insensitively; null when it is not an http or https URL. */
function siteAt(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    // Any scheme parses to a host; only a web page is a page of the site.
    return /^https?:$/.test(protocol) ? siteOf(hostname) : null;
  } catch {
    return null;
  }
}

/** Whether a list item has a repoint's fields, the optional ones absent or of their type. */
function isEntry(item: unknown): item is Partial<RepointEntry> & {
  companyNumber: string;
  url: string;
  newUrl: string;
} {
  const entry = item as Record<string, unknown> | null;
  return (
    typeof entry?.companyNumber === 'string' &&
    typeof entry.url === 'string' &&
    typeof entry.newUrl === 'string' &&
    (entry.newEvidenceUrl === undefined ||
      entry.newEvidenceUrl === null ||
      typeof entry.newEvidenceUrl === 'string') &&
    (entry.keepLive === undefined || typeof entry.keepLive === 'boolean')
  );
}

/** Why an entry's new address cannot be written, or null when it can. */
function refusal(entry: RepointEntry): string | null {
  if (normaliseWebsiteUrl(entry.newUrl) !== entry.newUrl) {
    return 'newUrl must be an address as a row stores it, https://host[/path]';
  }
  const site = siteAt(entry.newUrl);
  if (!site || isAggregatorHost(site)) {
    return "newUrl is a directory's address, not a company's site";
  }
  if (entry.newEvidenceUrl !== null && siteAt(entry.newEvidenceUrl) !== site) {
    return 'newEvidenceUrl must be a page of the new site';
  }
  return null;
}

/** The list as given, or why it cannot run; an entry at fault is named by its place in the list, never by its company. */
export function parseRepoints(json: unknown): RepointEntry[] | string {
  if (!Array.isArray(json) || !json.every(isEntry)) {
    return 'the list must be [{ companyNumber, url, newUrl, newEvidenceUrl?, keepLive? }]';
  }
  // Each write is guarded on one snapshot of the row.
  if (new Set(json.map((e) => e.companyNumber)).size < json.length) {
    return 'a company is listed twice; list its other move in a second run';
  }
  const entries = json.map(
    ({ companyNumber, url, newUrl, newEvidenceUrl, keepLive }) => ({
      companyNumber,
      url,
      newUrl,
      newEvidenceUrl: newEvidenceUrl ?? null,
      keepLive: keepLive ?? false,
    }),
  );
  for (const [index, entry] of entries.entries()) {
    const why = refusal(entry);
    if (why) return `entry ${index + 1}: ${why}`;
  }
  return entries;
}
