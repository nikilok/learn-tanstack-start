// The TUI owns the whole screen while it runs, like vim or less: the alternate buffer keeps the
// shell's scrollback out of the app, and alternate-scroll mode (DECSET 1007) has the terminal
// send wheel ticks as arrow keys, so the mouse scrolls the pane rather than terminal history.
// Deliberately NOT mouse reporting (DECSET 1000): that would take plain text selection away.

/** Alternate buffer + wheel-as-arrows + cursor home, so ink paints a clean screen from the top. */
const ENTER = '\x1b[?1049h\x1b[?1007h\x1b[H';
/** Symmetric restore. Leaving the alt buffer discards it and the shell reappears untouched. */
const LEAVE = '\x1b[?1007l\x1b[?1049l';

let entered = false;

/** Switch to the TUI screen. No-op without a TTY, so headless runs never emit control codes. */
export function enterTuiScreen(out: NodeJS.WriteStream = process.stdout): void {
  if (!out.isTTY || entered) return;
  entered = true;
  // Every way out — q, ctrl-c, a crash — must restore, or the shell is left on the app buffer.
  process.once('exit', () => leaveTuiScreen(out));
  out.write(ENTER);
}

/** Back to the shell's own buffer. Safe to call twice; the exit hook makes that the normal case. */
export function leaveTuiScreen(out: NodeJS.WriteStream = process.stdout): void {
  if (!entered) return;
  entered = false;
  out.write(LEAVE);
}
