// Recent activity for the denied identities, so the bans pane can say whether each ban is still
// earning its place.
//
// JA4 only. There is NO AS-number dimension in the observability API — geoAsNumber/asNumber/
// clientAsn are all rejected — and `asnName` cannot be derived from an AS number. A denied ASN
// therefore reports UNKNOWN, never zero: zero reads as "safe to retire", and a zero-filled
// version of this said exactly that about a denied network still under active load.

import { countOf, makeCtx, metrics } from './observability';
import { errMsg } from './util';

export type Activity = { requests: number; denied: number };

/** Hits per denied JA4 digest over the last `hours`. A key absent from the map means unknown, not zero — only digests the query actually covered are present. */
export async function fetchDenyActivity(
  creds: { projectId: string; teamId: string; token: string },
  hours: number,
  ja4: string[],
): Promise<{ activity: Map<string, Activity>; error?: string }> {
  const activity = new Map<string, Activity>();
  if (!ja4.length) return { activity };
  const { ctx } = makeCtx(creds, { hours });
  // Interpolated into the filter DSL, so only digests the spec already validated.
  const list = ja4.map((v) => `'${v}'`).join(',');
  try {
    const resp = await metrics(ctx, ['clientJa4Digest', 'wafAction'], {
      filter: `clientJa4Digest in (${list})`,
      limit: 500,
    });
    // The query succeeded, so a digest with no rows genuinely saw nothing.
    for (const v of ja4) activity.set(v, { requests: 0, denied: 0 });
    for (const row of resp.summary ?? []) {
      const key = String(row.clientJa4Digest ?? '');
      if (!key) continue;
      const count = countOf(row);
      const cur = activity.get(key) ?? { requests: 0, denied: 0 };
      cur.requests += count;
      if (String(row.wafAction ?? '') === 'deny') cur.denied += count;
      activity.set(key, cur);
    }
  } catch (e) {
    // Leave the map empty: unknown is reported as unknown, never as quiet.
    return { activity, error: errMsg(e) };
  }
  return { activity };
}
