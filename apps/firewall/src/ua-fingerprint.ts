// Does a client's claimed browser match the TLS stack it actually negotiates?
//
// A JA4 is a client BUILD. A real Chrome 142 emits one fingerprint, and it is the SAME
// fingerprint whether it runs headed or headless — so a client sending Chrome 142's user-agent
// while negotiating something else is not that browser.
//
// GRANULARITY, measured 2026-08-12 and worth knowing before trusting this: the comparison is on
// the EXACT user-agent string, and that is much weaker than a substring view suggests. Aggregating
// every string containing `Chrome/142.0.0.0 Safari/537.36`, the impersonator held 7% against the
// real build's 76%. On the exact Windows string it holds 24% while the two largest rivals hold
// 34% and 34% — nobody owns it, so nothing fires. On its other five strings the impersonator is
// itself the dominant source site-wide (72-82%). So on the identity that motivated this module,
// this check finds only its stale Chrome 119-124 tail: 12 of 651 requests.
//
// A "one fingerprint claims many browser majors" test looks like the stronger, baseline-free
// version of this. It is REFUTED, measured 2026-08-12, and the refutation is worse than the
// middlebox objection it was raised against: multi-major is the NORMAL shape of every large real
// digest here. `…_222222222222` carries 168 user-agent strings — Chrome 91 through 152, Edge 121
// through 151, plus Firefox, Safari and Opera across five platforms — at 61% rendering. Chromium's
// ClientHello barely moves between releases, so one JA4 legitimately spans years of versions and
// both Chrome and Edge. That test is not merely middlebox-unsafe, it is mainline-unsafe: it fires
// on the top of the real population. Do not build it.
//
// The property that makes this worth having is that every escape is expensive for the client and
// cheap for us: rotating IPs does nothing (the fingerprint is fixed), rotating user-agents HARDER
// strengthens the signal (the contradiction is what rotation creates), settling on one consistent
// user-agent throws away the reason they were rotating, and actually running the browser they
// claim costs them roughly two orders of magnitude and makes them solvable by a challenge.
//
// It reports evidence and nothing else. It is deliberately NOT an axis in `ban-advice.ts` this
// pass — see the middlebox note on `uaFingerprintCheck`, which is a real population of real users
// that looks exactly like this.

/** One site-wide (user-agent, fingerprint) pair and how many requests carried it. */
export type UaPair = { ua: string; digest: string; count: number };

export type UaBaseline = {
  /** Every fingerprint seen sending each user-agent, site-wide, descending by volume. */
  byUa: Map<string, { digest: string; count: number }[]>;
  /**
   * False when the grouping hit the API's group cap.
   *
   * NOT a hard gate, because this particular grouping truncates on any real site — a hard gate
   * would make the signal permanently undecidable and therefore useless. It is handled by
   * arithmetic instead (see `uaFingerprintCheck`) and reported as a caveat.
   */
  complete: boolean;
};

/** A user-agent whose real home is a different fingerprint than the one claiming it. */
export type UaMismatch = {
  ua: string;
  /** The SUBJECT's own requests carrying this user-agent. */
  requests: number;
  /** The subject fingerprint's share of this user-agent site-wide. */
  subjectShare: number;
  /** The fingerprint that actually owns this user-agent, and by how much. */
  rivalDigest: string;
  rivalShare: number;
};

export type UaVerdict = {
  /**
   * `null` means UNDECIDABLE, never "checked and consistent". The two are opposite conclusions
   * and collapsing them is this tool's recurring defect: an empty result that reads as a clean
   * bill of health.
   */
  mismatched: UaMismatch[] | null;
  /** Subject requests on contradicted user-agents, over its total. `null` when undecidable. */
  share: number | null;
  note: string;
};

/**
 * Below this share of a user-agent, the subject is a bystander on it rather than its source.
 * Structural rather than calibrated — it is not tuned against a measured traffic distribution, so
 * unlike the screening floors it does not belong in `.env.local`.
 */
const BYSTANDER = 0.25;
/** Above this, a rival fingerprint is the user-agent's genuine home rather than one voice among many. */
const OWNER = 0.5;

/** Fold the site-wide grouping into a per-user-agent distribution. */
export function buildUaBaseline(
  pairs: readonly UaPair[],
  complete: boolean,
): UaBaseline {
  const byUa = new Map<string, { digest: string; count: number }[]>();
  for (const p of pairs) {
    if (!p.ua || !p.digest) continue;
    const list = byUa.get(p.ua) ?? [];
    list.push({ digest: p.digest, count: p.count });
    byUa.set(p.ua, list);
  }
  for (const list of byUa.values()) list.sort((a, b) => b.count - a.count);
  return { byUa, complete };
}

/**
 * Which of a subject's claimed user-agents contradict its own fingerprint.
 *
 * Two safeguards decide the shape of this, and both make it fail SILENT rather than wrong:
 *
 * **Poisoning.** Where the subject is itself the dominant source of a user-agent on this site, it
 * becomes its own baseline and no rival can clear `OWNER` — so nothing fires. That is the correct
 * direction: a loud client immunises itself against this signal rather than convicting itself with
 * it. Measured on the same identity, its Edge 144/145 strings read 82% and 60% subject-owned and
 * are silent, while its Chrome 142/143 strings read 7% and 30% and fire.
 *
 * **Truncation.** The site-wide grouping hits the group cap on any real site, and a dropped row is
 * indistinguishable from an absent one. Dropping a RIVAL's row lowers its share and silences the
 * check, which is safe. Dropping the SUBJECT's own row would read as zero and fire spuriously —
 * so the subject's count comes from its own filtered profile, never from the baseline, and the
 * denominator takes whichever total is larger. Truncation can then only ever under-report.
 */
export function uaFingerprintCheck(opts: {
  digest: string;
  /** The subject's own user-agent counts, from its filtered profile query. */
  subjectUas: readonly [string, number][];
  subjectTotal: number;
  baseline: UaBaseline;
}): UaVerdict {
  const { digest, subjectUas, subjectTotal, baseline } = opts;
  if (!baseline.byUa.size)
    return {
      mismatched: null,
      share: null,
      note: 'the site-wide user-agent baseline could not be read, so whether this client is impersonating a browser is UNKNOWN',
    };
  if (!subjectUas.length || !digest)
    return {
      mismatched: null,
      share: null,
      note: 'no user-agent or fingerprint recorded for this subject — nothing to compare',
    };

  const mismatched: UaMismatch[] = [];
  let contradicted = 0;
  let compared = 0;
  // Case-insensitive: dashboards render these hashes upper-case and an operator can paste one
  // straight into the profiler, so a case-only difference would classify the subject's OWN
  // baseline row as a rival — which reads as "a bystander on a user-agent it actually owns" and
  // fires the check on an identity it should be silent about.
  const self = digest.toLowerCase();
  for (const [ua, mine] of subjectUas) {
    const dist = baseline.byUa.get(ua);
    if (!dist?.length) continue; // absent from the baseline is unknown, not a contradiction
    const rival = dist.find((d) => d.digest.toLowerCase() !== self);
    if (!rival) continue; // only this fingerprint sends it — no baseline to contradict
    compared++;
    // `mine` from the subject's own query, and the larger of the two totals: see the truncation
    // note above. Both choices push the ratio away from firing.
    const seen = dist.reduce((s, d) => s + d.count, 0);
    const total = Math.max(seen, mine);
    if (!total) continue;
    const subjectShare = mine / total;
    const rivalShare = rival.count / total;
    if (subjectShare < BYSTANDER && rivalShare >= OWNER) {
      mismatched.push({
        ua,
        requests: mine,
        subjectShare,
        rivalDigest: rival.digest,
        rivalShare,
      });
      contradicted += mine;
    }
  }

  if (!compared)
    return {
      mismatched: null,
      share: null,
      note: 'none of this subject’s user-agents appear on any other fingerprint, so there is nothing to compare it against',
    };

  const share = subjectTotal > 0 ? contradicted / subjectTotal : 0;
  const floors = baseline.complete
    ? ''
    : ' (baseline hit the API group cap, so these are floors — it can only under-report)';
  return {
    mismatched,
    share,
    note: mismatched.length
      ? `${mismatched.length} of ${compared} comparable user-agents belong to a DIFFERENT fingerprint — ${contradicted} of ${subjectTotal} requests claim a browser this TLS stack does not produce${floors}`
      : `every comparable user-agent (${compared}) is consistent with this fingerprint${floors}`,
  };
}

/**
 * Shorten a user-agent from the MIDDLE.
 *
 * Head-truncating is what a first version did, and it was useless here: every modern UA opens
 * with the same ~50 characters of `Mozilla/5.0 (Platform) AppleWebKit/537.36 …` and carries the
 * browser VERSION at the end — which is the entire subject of this check. Four contradicted
 * strings all rendered as the identical prefix. Keep both ends.
 */
export function shortUa(ua: string, width = 64): string {
  if (ua.length <= width) return ua;
  const half = Math.floor((width - 1) / 2);
  return `${ua.slice(0, half)}…${ua.slice(-half)}`;
}

/**
 * One line per contradicted user-agent, for the signals pane.
 *
 * Clamped to the head of the LIST: an impersonator rotates dozens of strings and the pane has to
 * stay readable, while the count in the note above already carries the total.
 */
export function mismatchLines(v: UaVerdict, limit = 4): string[] {
  if (!v.mismatched?.length) return [];
  return v.mismatched
    .slice(0, limit)
    .map(
      (m) =>
        `${m.requests}x "${shortUa(m.ua)}" — ${(m.subjectShare * 100).toFixed(0)}% here vs ${(m.rivalShare * 100).toFixed(0)}% on ${m.rivalDigest}`,
    );
}
