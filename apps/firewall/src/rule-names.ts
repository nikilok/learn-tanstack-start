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
