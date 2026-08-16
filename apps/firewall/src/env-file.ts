// Persisting a staged deny back to .env.local.
//
// The denylists are rebuilt from env on every apply, so a digest that lives only in the WAF is
// silently un-banned by the next `--apply`. Writing it back is what keeps CI and the TUI agreeing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * FW_* assignments from an env file, read directly rather than through the environment.
 *
 * A mock session runs with `--no-env-file` so the real credentials never enter the process, which
 * also means anything configured in `.env.local` is invisible to it. Reading the file by hand for
 * an allow-listed prefix gets configuration back without getting credentials back with it: a
 * VERCEL_TOKEN sitting in the same file cannot come through this.
 */
export function readFwVars(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!key.startsWith('FW_')) continue;
    out[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Set `key` in a .env file's text, replacing the last uncommented assignment or appending one. Returns the new text; comments, ordering and unrelated keys are preserved. */
export function upsertEnvLine(
  content: string,
  key: string,
  value: string,
): string {
  const lines = content.split('\n');
  // Escaped: every caller passes an FW_* literal today, but a key containing . or + would
  // silently match a different line.
  const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assign = new RegExp(`^\\s*(export\\s+)?${safe}\\s*=`);
  // Last match wins, mirroring how dotenv-style loaders resolve a duplicated key.
  let at = -1;
  for (const [i, l] of lines.entries()) if (assign.test(l)) at = i;
  const next = `${key}=${value}`;
  if (at !== -1) {
    lines[at] = next;
    return lines.join('\n');
  }
  // Append, keeping exactly one trailing newline whether or not the file had one.
  const body = content.replace(/\n+$/, '');
  return body ? `${body}\n${next}\n` : `${next}\n`;
}

/** Read-modify-write `key` in the env file at `path`. */
export function persistEnvVar(path: string, key: string, value: string): void {
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch (e) {
    // Only a genuinely absent file is safe to read as empty — the upsert then creates the
    // assignment. Any other failure and we would write a one-line file over a real one,
    // destroying every unrelated secret in it.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  writeFileSync(path, upsertEnvLine(current, key, value), 'utf8');
}
