// A tiny rich-text line model. Views build these; the CLI renders them to ANSI and the TUI renders
// them as Ink nodes, so a pane's layout is written once and looks the same in both.

export type Tone = 'plain' | 'dim' | 'bold' | 'good' | 'bad' | 'warn' | 'key';
export type Seg = { text: string; tone?: Tone };
export type Line = Seg[];

const ANSI: Record<Tone, string> = {
  plain: '',
  dim: '[2m',
  bold: '[1m',
  good: '[32m',
  bad: '[31m',
  warn: '[33m',
  key: '[36m',
};
const RESET = '[0m';

export const seg = (text: string, tone?: Tone): Seg => ({ text, tone });
export const line = (...segs: (Seg | string)[]): Line =>
  segs.map((s) => (typeof s === 'string' ? { text: s } : s));
export const blank = (): Line => [];

/** Plain text of a line, ignoring tone — the basis for width measurement and truncation. */
export function lineText(l: Line): string {
  return l.map((s) => s.text).join('');
}

/** Truncate to `width` columns, tone-aware, appending `…` when it cuts. Never splits an escape sequence, because tone is applied after truncation rather than embedded in the text. */
export function truncate(l: Line, width: number): Line {
  if (width <= 0 || lineText(l).length <= width) return l;
  const out: Line = [];
  let left = width - 1; // room for the ellipsis
  for (const s of l) {
    if (left <= 0) break;
    if (s.text.length <= left) {
      out.push(s);
      left -= s.text.length;
    } else {
      out.push({ text: s.text.slice(0, left), tone: s.tone });
      left = 0;
    }
  }
  out.push({ text: '…', tone: 'dim' });
  return out;
}

/** Render lines to a terminal string. `colour` off (piped output) emits plain text. */
export function toAnsi(
  lines: Line[],
  opts: { colour: boolean; width?: number },
): string {
  return lines
    .map((l) => {
      const clipped = opts.width ? truncate(l, opts.width) : l;
      if (!opts.colour) return lineText(clipped);
      return clipped
        .map((s) =>
          s.tone && s.tone !== 'plain'
            ? `${ANSI[s.tone]}${s.text}${RESET}`
            : s.text,
        )
        .join('');
    })
    .join('\n');
}

/** Count-first rows (`  1234  label`), truncated with a tail that states what was dropped. */
export function countRows(
  rows: [string, number][],
  limit: number,
  indent = '  ',
): Line[] {
  const out = rows
    .slice(0, limit)
    .map(([k, n]) =>
      line(`${indent}${String(n).padStart(7)}  `, seg(k, 'plain')),
    );
  if (rows.length > limit) {
    const rest = rows.slice(limit).reduce((s, [, n]) => s + n, 0);
    out.push(
      line(
        seg(
          `${indent}${' '.repeat(7)}  … +${rows.length - limit} more (${rest} req)`,
          'dim',
        ),
      ),
    );
  }
  return out;
}

/** Same rows under a left-hand label shown once, for identity blocks. */
export function labelledRows(
  label: string,
  rows: [string, number][],
  limit: number,
): Line[] {
  return rows
    .slice(0, limit)
    .map(([k, n], i) =>
      line(
        seg(`  ${(i === 0 ? label : '').padEnd(9)}`, 'dim'),
        `${String(n).padStart(6)}  `,
        seg(k),
      ),
    );
}
