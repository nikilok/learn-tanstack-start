// The bans pane: what is currently denied, and whether each ban is still doing any work.
//
// A ban nobody reviews is a ban nobody can undo. Recent-activity counts answer the question that
// decides it: a digest still generating denials is holding a scraper off, one at zero has either
// rotated away or was never the right handle, and is a rule worth retiring.

import { type Line, blank, line, seg } from './line-model';

export type DenyEntry = {
  kind: 'ja4' | 'asn';
  value: string;
  staged: boolean; // added this session, not yet applied to the WAF
  removed: boolean; // unbanned this session, not yet applied
  requests?: number; // hits in the window; undefined when the lookup failed
  denied?: number; // how many of those the firewall actually denied
};

export type DenylistReport = {
  windowHours: number;
  entries: DenyEntry[];
  // Deny rules that exist but are not denying — deactivated, or cycled to log/challenge. Their
  // values are withheld from `entries` because listing them as `live` would read as enforced.
  notEnforcing?: { rule: string; why: string }[];
  error?: string;
};

/** One row: state marker, value, then what it has caught lately. */
function entryLines(e: DenyEntry, isCursor: boolean): Line[] {
  const marker = isCursor ? '▶ ' : '  ';
  const state = e.removed
    ? seg('UNBANNED ', 'warn')
    : e.staged
      ? seg('STAGED   ', 'warn')
      : seg('live     ', 'dim');
  const L = [
    line(
      seg(marker, 'key'),
      state,
      seg(e.kind.toUpperCase().padEnd(5), 'dim'),
      seg(e.value, isCursor ? 'key' : 'plain'),
    ),
  ];
  const detail =
    e.requests === undefined
      ? e.kind === 'asn'
        ? 'activity not measurable — the API exposes no AS-number dimension'
        : 'activity unknown — the lookup failed, so draw no conclusion'
      : e.requests === 0
        ? 'no traffic in the window — rotated away or never the right handle; safe to retire'
        : `${e.requests} req · ${e.denied ?? 0} denied`;
  L.push(line(seg(`       ${detail}`, 'dim')));
  return L;
}

/** Full bans layout. `cursor` indexes `entries`. */
export function denylistLines(r: DenylistReport, cursor: number): Line[] {
  const L: Line[] = [
    line(
      seg('Denylist', 'bold'),
      seg(`  last ${r.windowHours}h activity`, 'dim'),
    ),
  ];
  // Before the counts: a rule that is not denying makes every number below it a lie.
  for (const n of r.notEnforcing ?? [])
    L.push(
      blank(),
      line(seg(`  ${n.rule} IS NOT DENYING — ${n.why}`, 'bad')),
      line(
        seg(
          '  its entries are withheld below; nothing it lists is being blocked',
          'bad',
        ),
      ),
    );
  if (!r.entries.length) {
    L.push(
      blank(),
      r.notEnforcing?.length
        ? line(seg('  nothing is being denied', 'bad'))
        : line(seg('  nothing is denied', 'good')),
    );
    // An empty list plus a failed lookup is unknown, not clean — the same distinction the rest
    // of this tool exists to preserve.
    if (r.error)
      L.push(blank(), line(seg(`  activity lookup: ${r.error}`, 'warn')));
    return L;
  }
  const pending = r.entries.filter((e) => e.staged || e.removed).length;
  L.push(
    line(
      seg(
        `${r.entries.filter((e) => !e.removed).length} denied` +
          (pending
            ? ` · ${pending} unapplied change${pending === 1 ? '' : 's'}`
            : ''),
      ),
    ),
  );
  if (pending)
    L.push(
      line(
        seg('  press a to apply — nothing reaches the WAF until then', 'warn'),
      ),
    );
  L.push(blank());
  r.entries.forEach((e, i) => L.push(...entryLines(e, i === cursor)));
  if (r.error)
    L.push(blank(), line(seg(`  activity lookup: ${r.error}`, 'warn')));
  return L;
}
