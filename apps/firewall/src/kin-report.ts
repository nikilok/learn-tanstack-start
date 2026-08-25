// What else is on the TLS build line of an identity we have already acted on.
//
// Shows the line rather than judging it. A client that rebuilds keeps its JA4 profile and cipher
// list, so the siblings of a denied digest are worth a look — but a build line is shared, and
// deciding which sibling is a rebuild is the operator's call, not this file's.

import { JA4_DENY, envMatching } from './deny-list';
import { familyOf, renderSharesByDigest } from './ja4-family';
import { type Ctx, type Row, countOf, makeCtx, metrics } from './observability';
import type { Window } from './time-window';

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
   * False when the route response hit the group cap, so a member — or a member's rendering —
   * may be missing. Rendered as a warning rather than silently weakening every share below.
   */
  complete: boolean;
};

/** Both denylists, each entry tagged with which list it came from. Unreadable lists are empty, and an empty report says so rather than reading as "nothing is listed". */
export function listedStandings(): Map<string, Standing> {
  const out = new Map<string, Standing>();
  for (const [name, standing] of [
    ['FW_CHALLENGE_JA4', 'challenged'],
    // Denied second: a digest on both lists is denied in effect, since insertion order gives the
    // deny live priority, and the report must not call it the lesser tier.
    ['FW_BLOCKED_JA4', 'denied'],
  ] as const) {
    try {
      for (const d of envMatching(name, JA4_DENY, false))
        out.set(JA4_DENY.normalize(d), standing);
    } catch {
      // An unreadable list contributes nothing. The caller reports `listed`, so a zero is visible.
    }
  }
  return out;
}

/** Assemble the report from one digest×route summary and one verified summary. Pure, so the shape is testable without a network. */
export function buildKinReport(
  window: Window,
  routeRows: Row[],
  verifiedRows: Row[],
  standings: Map<string, Standing>,
  complete: boolean,
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
  return buildKinReport(
    window,
    routeRows,
    (verifiedResp.summary ?? []).filter((r) => countOf(r) > 0),
    listedStandings(),
    routeRows.length < GROUP_CAP,
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
