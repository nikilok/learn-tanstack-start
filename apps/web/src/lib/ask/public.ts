/**
 * Whether asking is open to every visitor: `VITE_ASK_PUBLIC=1`, read at build,
 * so the server's render and the browser's agree on what the page offers.
 * Unset, only the owner is offered it (lib/ask/access-hint).
 */
export const ASK_PUBLIC = import.meta.env.VITE_ASK_PUBLIC === '1';
