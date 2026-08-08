// Names shared between the rule definitions and the advisory that reads them back.
//
// One definition, not two that agree. The advisory treats a hit on a header-gated rule as proof
// of a first-party caller, and it matches by name — so a rename in rules.ts with a stale copy in
// ban-advice.ts would remove that protection with nothing failing anywhere. Our own ch-stream
// listener renders nothing, verifies as nothing and does steady volume, which makes it
// indistinguishable from a harvester on every axis except this one.
//
// Kept in its own module because rules.ts reads required ceilings from the environment at import
// time, so anything that only needs a name cannot import it.

export const CH_STREAM_REVALIDATE = 'allow-ch-stream-revalidate';
export const DESKTOP_RELEASE_RECORD = 'allow-desktop-release-record';

/**
 * Rules gated on a bespoke secret header — the only ones that prove a first-party caller.
 *
 * Membership is explicit, never a name prefix: an `allow-*` rule matching on anything the caller
 * controls, a User-Agent say, would certify every spoofer as first-party AND make them
 * permanently unbannable.
 */
export const HEADER_GATED_RULES = [
  CH_STREAM_REVALIDATE,
  DESKTOP_RELEASE_RECORD,
];

export const CHALLENGE_SCRAPER_JA4 = 'challenge-scraper-ja4';

/**
 * Rules that must never enforce with a deny — the tier an unattended writer may add to.
 *
 * Identified by NAME because a name is durable and an action is not. Keying the guard off
 * `mitigate.action === 'challenge'` meant the protection vanished the moment the tier was
 * switched off: cycling it to `log` made it an ordinary rule again, so one further press reached
 * `deny`, and rebuilding it to stage an entry coerced it to `deny` outright. The thing being
 * protected cannot be the same thing that identifies what to protect.
 */
export const RECOVERABLE_RULES = [CHALLENGE_SCRAPER_JA4];

/** Whether a rule belongs to the recoverable tier, whatever action it currently carries. */
export function isRecoverableRule(name: string): boolean {
  return RECOVERABLE_RULES.includes(name);
}
