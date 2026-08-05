// Copying a value out of the TUI. A JA4 is 37 characters of hex and underscores — exactly the
// kind of thing that gets mistyped, and a mistyped digest in a deny rule matches nothing.

// A clipboard helper that is missing or waiting on a dead display server must not hang the TUI.
const COPY_TIMEOUT_MS = 2000;

/** Platform clipboard commands to try in order, or [] where we know none. */
function clipboardCommands(): string[][] {
  if (process.platform === 'darwin') return [['pbcopy']];
  if (process.platform === 'win32') return [['clip']];
  // Wayland first (wl-copy works under both), then X11, which is still the common case.
  if (process.platform === 'linux')
    return [
      ['wl-copy'],
      ['xclip', '-selection', 'clipboard'],
      ['xsel', '--clipboard', '--input'],
    ];
  return [];
}

/** Copy `text`, returning null on success or a short reason it failed. Never throws — a failed copy must not take the TUI down. */
export async function copyToClipboard(text: string): Promise<string | null> {
  const cmds = clipboardCommands();
  if (!cmds.length) return `no clipboard command known for ${process.platform}`;
  let last = '';
  for (const cmd of cmds) {
    try {
      const proc = Bun.spawn(cmd, {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      proc.stdin.write(text);
      await proc.stdin.end();
      // Bounded: xclip holds the selection by design, and a hung helper would otherwise wedge
      // the keypress handler that awaited it.
      const code = await Promise.race([
        proc.exited,
        new Promise<'timeout'>((r) =>
          setTimeout(() => r('timeout'), COPY_TIMEOUT_MS),
        ),
      ]);
      if (code === 'timeout') {
        proc.kill();
        last = `${cmd[0]} timed out`;
        continue;
      }
      if (code === 0) return null;
      last = `${cmd[0]} exited ${code}`;
    } catch {
      last = `${cmd[0]} not available`;
    }
  }
  return last;
}
