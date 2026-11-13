// The readable hint the owner cookie leaves beside itself (owner.server.ts),
// so a document knows at mount whether to offer asking. The server still
// decides on every request: a forged hint only shows an offer the mint then
// refuses, and the document closes.

export const OWNER_HINT_COOKIE = 'ss-owner-hint';

/** Whether the document carries the owner hint. Never throws: no document, no hint. */
export function hasOwnerHint(): boolean {
  try {
    return document.cookie
      .split(';')
      .some((part) => part.trim().startsWith(`${OWNER_HINT_COOKIE}=`));
  } catch {
    return false;
  }
}
