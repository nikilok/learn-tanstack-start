/**
 * Minimal RFC-4180 CSV read/write, for files a human edits in a spreadsheet
 * between two runs of a script.
 *
 * Hand-rolled rather than a dependency because the shape is tiny and the
 * failure mode of getting it wrong is loud: company names contain commas
 * ("Smith, Jones and Co Limited") and apostrophes, so a naive split shifts
 * every column right and silently mislabels the row.
 */

/** Quote a field only when it needs it, doubling any embedded quotes. */
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serialise rows (objects keyed by the given columns) to CSV text. */
export function toCsv<T extends Record<string, unknown>>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(
      columns.map((col) => escapeField(String(row[col] ?? ''))).join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Split one CSV line, honouring quotes and doubled escapes. */
function parseLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

/**
 * Parse CSV text into objects keyed by the header row. Rows whose field count
 * does not match the header are returned in `malformed` rather than silently
 * dropped or padded — a shifted row is exactly the bug that matters here.
 */
export function fromCsv(text: string): {
  rows: Record<string, string>[];
  malformed: number[];
} {
  // Split on newlines that are not inside quotes.
  const lines: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === '\n' && !quoted) {
      lines.push(current.replace(/\r$/, ''));
      current = '';
    } else current += char;
  }
  if (current.trim()) lines.push(current.replace(/\r$/, ''));

  const [header, ...body] = lines;
  if (!header) return { rows: [], malformed: [] };
  const columns = parseLine(header);

  const rows: Record<string, string>[] = [];
  const malformed: number[] = [];
  body.forEach((line, index) => {
    if (!line.trim()) return;
    const fields = parseLine(line);
    if (fields.length !== columns.length) {
      malformed.push(index + 2); // 1-based, plus the header
      return;
    }
    rows.push(Object.fromEntries(columns.map((col, i) => [col, fields[i]])));
  });
  return { rows, malformed };
}
