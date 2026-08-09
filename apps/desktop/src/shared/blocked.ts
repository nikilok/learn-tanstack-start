/**
 * The `blocked:state` payload, shared by the three processes that have to agree on it:
 * main builds it, the preload bridge carries it, and the renderer draws from it.
 *
 * Here rather than in any one of them because a contract that crosses a process boundary
 * cannot be checked by the compiler if each side keeps its own copy — main and the
 * renderer had matching declarations and the bridge in between typed it `unknown`, so a
 * field added on one side would have reached the other as a silent undefined.
 */

/** Why the local stand-in screen is up, and what it counts down to. */
export type BlockReason = 'blocked' | 'offline' | 'unreachable';

/** What the screen renders: why it is up, when the next check runs, whether one is in flight. */
export interface BlockState {
  reason: BlockReason;
  retryAt: number; // epoch ms
  checking: boolean;
}
