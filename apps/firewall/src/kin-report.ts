// What else is on the TLS build line of an identity we have already acted on.
//
// Shows the line rather than judging it. A client that rebuilds keeps its JA4 profile and cipher
// list, so the siblings of a denied digest are worth a look — but a build line is shared, and
// deciding which sibling is a rebuild is the operator's call, not this file's.

import { JA4_DENY, envMatching } from './deny-list';
import { familyOf, renderSharesByDigest } from './ja4-family';
import { type Ctx, type Row, countOf, makeCtx, metrics } from './observability';
import type { Window } from './time-window';
import { errMsg } from './util';

/** Above this share of rendering requests, a browser has run the app from the fingerprint. */
export const BROWSER_SHARE = 0.05;

const PASSED = "wafAction ne 'deny' and wafAction ne 'challenge'";
const GROUP_CAP = 500;

/** How an identity is already handled, or null for one we have never acted on. */
export type Standing = 'denied' | 'challenged' | null;

export type KinMember = {
  digest: string;
  requests: number;
  /** Share of requests that are assets, tiles, beacons or RPCs. High means a browser ran the app. */
  renderShare: number;
  verified: boolean;
  standing: Standing;
};

export type KinFamily = {
  family: string;
  standing: Standing;
  members: KinMember[];
};

export type KinReport = {
  window: Window;
  families: KinFamily[];
  listed: number;
  /**
   * False when EITHER summary hit the group cap. The route one can drop a member or its
   * rendering; the verified one can drop the proof that a member is a crawler, which would
   * otherwise promote it to something worth profiling. Rendered as a warning rather than
   * silently weakening every reading below.
   */
  complete: boolean;
  /** Lists that could not be read. Non-empty means `listed` is a floor and may be zero for the wrong reason. */
  unreadable: string[];
};

/**
 * Both denylists, each entry tagged with which list it came from.
 *
 * An unreadable list is reported, never swallowed. Dropping the error left an empty map, and an
 * empty map renders as "nothing is denied or challenged" — an affirmative claim about the WAF's
 * state, made because we failed to read our own config.
 */
export function listedStandings(): {
  standings: Map<string, Standing>;
  unreadable: string[];
} {
  const out = new Map<string, Standing>();
  const unreadable: string[] = [];
  for (const [name, standing] of [
    ['FW_CHALLENGE_JA4', 'challenged'],
    // Denied second: a digest on both lists is denied in effect, since insertion order gives the
    // deny live priority, and the report must not call it the lesser tier.
    ['FW_BLOCKED_JA4', 'denied'],
  ] as const) {
    try {
      for (const d of envMatching(name, JA4_DENY, false))
        out.set(JA4_DENY.normalize(d), standing);
    } catch (e) {
      unreadable.push(`${name}: ${errMsg(e)}`);
    }
  }
  return { standings: out, unreadable };
}

/** Assemble the report from one digest×route summary and one verified summary. Pure, so the shape is testable without a network. */
export function buildKinReport(
  window: Window,
  routeRows: Row[],
  verifiedRows: Row[],
  standings: Map<string, Standing>,
  complete: boolean,
  unreadable: string[] = [],
): KinReport {
  const shares = renderSharesByDigest(routeRows);
  const verified = new Set(
    verifiedRows
      .filter((r) => String(r.botVerified ?? '') === 'pass')
      .map((r) => JA4_DENY.normalize(String(r.clientJa4Digest ?? '')))
      .filter(Boolean),
  );
  const wanted = new Set(
    [...standings.keys()].map(familyOf).filter((f) => f !== ''),
  );
  const byFamily = new Map<string, KinMember[]>();
  for (const [digest, { total, share }] of shares) {
    const family = familyOf(digest);
    if (!family || !wanted.has(family)) continue;
    const member: KinMember = {
      digest,
      requests: total,
      renderShare: share,
      verified: verified.has(digest),
      standing: standings.get(digest) ?? null,
    };
    byFamily.set(family, [...(byFamily.get(family) ?? []), member]);
  }
  const families = [...wanted].map((family) => ({
    family,
    // The strongest standing on the line: a denied member censors this window's evidence for the
    // whole family, because a denied request never reaches routing and contributes no rows.
    standing: [...standings]
      .filter(([d]) => familyOf(d) === family)
      .some(([, s]) => s === 'denied')
      ? ('denied' as const)
      : ('challenged' as const),
    members: (byFamily.get(family) ?? []).sort(
      (a, b) => b.requests - a.requests,
    ),
  }));
  return {
    window,
    listed: standings.size,
    complete,
    unreadable,
    families: families.sort((a, b) => b.members.length - a.members.length),
  };
}

/** Fetch the two summaries the report needs and assemble it. */
export async function fetchKinReport(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
  query: typeof metrics = metrics,
): Promise<KinReport> {
  const { ctx }: { ctx: Ctx } = makeCtx(creds, window);
  const [routeResp, verifiedResp] = await Promise.all([
    query(ctx, ['clientJa4Digest', 'route'], {
      filter: PASSED,
      limit: GROUP_CAP,
    }),
    query(ctx, ['clientJa4Digest', 'botVerified'], {
      filter: PASSED,
      limit: GROUP_CAP,
    }),
  ]);
  const routeRows = (routeResp.summary ?? []).filter((r) => countOf(r) > 0);
  const verifiedRows = (verifiedResp.summary ?? []).filter(
    (r) => countOf(r) > 0,
  );
  const { standings, unreadable } = listedStandings();
  return buildKinReport(
    window,
    routeRows,
    verifiedRows,
    standings,
    // BOTH caps, matching the screen. A capped verification response can omit the row proving a
    // member is a crawler, and it would then read as an unverified member worth profiling.
    routeRows.length < GROUP_CAP &&
      (verifiedResp.summary ?? []).length < GROUP_CAP,
    unreadable,
  );
}

/**
 * Members worth a human look: on a listed build line, not listed themselves, not a verified
 * crawler, and rendering nothing.
 *
 * One definition, read by the CLI view and by the watch's status line. Two copies of this
 * threshold is exactly how the previous attempt drifted into disagreeing with itself.
 */
export function candidates(report: KinReport): KinMember[] {
  return report.families.flatMap((f) =>
    f.members.filter(
      (m) => !m.standing && !m.verified && m.renderShare <= BROWSER_SHARE,
    ),
  );
}
