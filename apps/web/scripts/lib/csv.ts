/**
 * Minimal RFC-4180 CSV read/write, for files a human edits in a spreadsheet
 * between two runs of a script.
 *
 * Hand-rolled rather than a dependency because the shape is tiny and the
 * failure mode of getting it wrong is loud: company names contain commas
 * ("Smith, Jones and Co Limited") and apostrophes, so a naive split shifts
 * every column right and silently mislabels the row.
 */

/**
 * Spreadsheet formula prefixes. A field beginning with one of these executes on
 * open in Excel, Numbers and Sheets, and everything written here comes from the
 * database — company names and URLs we did not author. Leading whitespace
 * counts, because the spreadsheet trims before deciding.
 */
const FORMULA_START = /^[\s]*[=+\-@]/;

/** Quote a field only when it needs it, doubling any embedded quotes. */
function escapeField(value: string, alwaysQuote: boolean): string {
  // Neutralise before quoting: a leading apostrophe makes the spreadsheet
  // treat the rest as text, and survives the round trip as part of the value.
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return alwaysQuote || /[",\r\n]/.test(safe)
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}

/** Serialise rows (objects keyed by the given columns) to CSV text. */
export function toCsv<T extends Record<string, unknown>>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): string {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((col) => {
          const value = String(row[col] ?? '');
          // With one column an empty value serialises to a blank line, which is
          // indistinguishable from the blank lines fromCsv skips, so the record
          // disappears. Quoting keeps it a record.
          const alwaysQuote = columns.length === 1 && value.trim() === '';
          return escapeField(value, alwaysQuote);
        })
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Split one CSV record, honouring quotes and doubled escapes.
 *
 * Reports `valid: false` rather than guessing. The consumer is a precision
 * measurement that refuses to score a file it cannot read, and an unterminated
 * quote can still yield the right field count — so field count alone is not a
 * corruption check.
 */
function parseRecord(line: string): { fields: string[]; valid: boolean } {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  /** A quoted field has closed; only a comma may legally follow it. */
  let closed = false;
  let valid = true;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === '"') {
      // A quote may only open a field, never appear inside a bare one.
      if (field.length === 0 && !closed) quoted = true;
      else valid = false;
    } else if (char === ',') {
      fields.push(field);
      field = '';
      closed = false;
    } else {
      if (closed) valid = false;
      field += char;
    }
  }
  // Ran off the end still inside a quote.
  if (quoted) valid = false;
  fields.push(field);
  return { fields, valid };
}

/** Split text into logical records, keeping each one's PHYSICAL start line. */
function splitRecords(text: string): { line: string; at: number }[] {
  const records: { line: string; at: number }[] = [];
  let current = '';
  let quoted = false;
  let physical = 1;
  let startedAt = 1;

  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === '\n' && !quoted) {
      records.push({ line: current.replace(/\r$/, ''), at: startedAt });
      current = '';
      physical += 1;
      startedAt = physical;
      continue;
    }
    if (char === '\n') physical += 1;
    current += char;
  }
  if (current.trim()) {
    records.push({ line: current.replace(/\r$/, ''), at: startedAt });
  }
  return records;
}

/**
 * Parse CSV text into objects keyed by the header row.
 *
 * Records whose field count does not match the header, or whose quoting is
 * invalid, are reported in `malformed` by PHYSICAL line number rather than
 * silently dropped or padded. A shifted row is the bug that matters here, and
 * the line number is what the caller tells a human to go and fix — so it has to
 * survive a legitimate multi-line record earlier in the file.
 */
export function fromCsv(text: string): {
  rows: Record<string, string>[];
  malformed: number[];
} {
  const records = splitRecords(text);
  const header = records.shift();
  if (!header) return { rows: [], malformed: [] };
  const columns = parseRecord(header.line).fields;

  const rows: Record<string, string>[] = [];
  const malformed: number[] = [];
  for (const record of records) {
    if (!record.line.trim()) continue;
    const { fields, valid } = parseRecord(record.line);
    if (!valid || fields.length !== columns.length) {
      malformed.push(record.at);
      continue;
    }
    rows.push(Object.fromEntries(columns.map((col, i) => [col, fields[i]])));
  }
  return { rows, malformed };
}
