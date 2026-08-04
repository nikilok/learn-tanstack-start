// Copying a value out of the TUI. A JA4 is 37 characters of hex and underscores — exactly the
// kind of thing that gets mistyped, and a mistyped digest in a deny rule matches nothing.

/** Platform clipboard command, or null where we do not know one. */
function clipboardCommand(): string[] | null {
  if (process.platform === 'darwin') return ['pbcopy'];
  if (process.platform === 'win32') return ['clip'];
  // Wayland first: wl-copy works under both, xclip only under X11.
  if (process.platform === 'linux') return ['wl-copy'];
  return null;
}

/** Copy `text`, returning null on success or a short reason it failed. Never throws — a failed copy must not take the TUI down. */
export async function copyToClipboard(text: string): Promise<string | null> {
  const cmd = clipboardCommand();
  if (!cmd) return `no clipboard command known for ${process.platform}`;
  try {
    const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
    proc.stdin.write(text);
    await proc.stdin.end();
    const code = await proc.exited;
    return code === 0 ? null : `${cmd[0]} exited ${code}`;
  } catch {
    return `${cmd[0]} not available`;
  }
}
