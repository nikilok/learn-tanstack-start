/**
 * Streaming reader for the one table inside an OpenDocument Spreadsheet.
 *
 * CQC publishes its provider directory (the only file carrying both a
 * Companies House number and a web address) as .ods only. That archive is 23MB
 * but its content.xml is ~439MB, so it cannot be read into memory — this scans
 * it as a stream, emitting one row at a time and never retaining more than the
 * current row plus the in-flight chunk.
 *
 * The zip member is piped from `unzip -p` rather than decoded in-process, the
 * same reason bulk-snapshot-match.ts shells out to curl for its 470MB download:
 * the tool already streams, and adding a zip dependency to read one member is
 * a worse trade.
 */

const ROW_END = '</table:table-row>';
const ROW_OPEN = /<table:table-row[\s>]/g;

/** Trailing empty cells are stored as one cell repeated ~16k times; nothing we
 *  read is anywhere near this wide, so expansion is capped rather than honoured. */
const DEFAULT_MAX_COLUMNS = 512;

export type OdsRow = Record<string, string>;

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
    (all, ent) => {
      switch (ent) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          const code =
            ent[1] === 'x' || ent[1] === 'X'
              ? Number.parseInt(ent.slice(2), 16)
              : Number.parseInt(ent.slice(1), 10);
          // Range check, not just isFinite: String.fromCodePoint THROWS above
          // U+10FFFF, and that throw escapes the replace callback, the parser
          // and the generator, so one malformed reference anywhere in the
          // ~439MB stream discards the entire month's import. Fall back to the
          // literal text, which is what the surrounding ternary intends.
          if (!Number.isInteger(code) || code < 0 || code > 0x10ffff)
            return all;
          return String.fromCodePoint(code);
        }
      }
    },
  );
}

/** Cell text is one or more <text:p> runs; <text:s>/<text:tab> are whitespace
 *  that would otherwise vanish with the tags. */
function cellText(inner: string): string {
  const spaced = inner
    .replace(/<text:s\b[^>]*\/?>/g, ' ')
    .replace(/<text:tab\b[^>]*\/?>/g, ' ')
    .replace(/<\/text:p>\s*<text:p[^>]*>/g, ' ');
  return decodeEntities(spaced.replace(/<[^>]*>/g, '')).trim();
}

/** Read a tag's attribute span, honouring quotes so a `>` inside an attribute
 *  value cannot terminate it early. Returns the index just past the closing
 *  `>`, and whether the tag was self-closing. */
function readTag(
  xml: string,
  from: number,
): { attrs: string; end: number; selfClosing: boolean } | null {
  let i = from;
  let quote: string | null = null;
  for (; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      const raw = xml.slice(from, i);
      const selfClosing = raw.endsWith('/');
      return {
        attrs: selfClosing ? raw.slice(0, -1) : raw,
        end: i + 1,
        selfClosing,
      };
    }
  }
  return null;
}

/**
 * Expand one `<table:table-row>` element into its cell values, honouring
 * `table:number-columns-repeated`. Pure, so the scanner can be tested without
 * an archive.
 */
export function parseOdsRowCells(
  rowXml: string,
  maxColumns: number = DEFAULT_MAX_COLUMNS,
): string[] {
  const cells: string[] = [];
  const cellOpen = /<table:(covered-table-cell|table-cell)\b/g;
  let match: RegExpExecArray | null;

  while ((match = cellOpen.exec(rowXml)) !== null) {
    if (cells.length >= maxColumns) break;
    const tag = readTag(rowXml, match.index + match[0].length);
    if (!tag) break;

    const repeatMatch = /table:number-columns-repeated="(\d+)"/.exec(tag.attrs);
    const repeat = repeatMatch ? Number.parseInt(repeatMatch[1], 10) : 1;

    let value = '';
    if (!tag.selfClosing) {
      const closeTag = `</table:${match[1]}>`;
      const closeAt = rowXml.indexOf(closeTag, tag.end);
      if (closeAt === -1) break;
      value = cellText(rowXml.slice(tag.end, closeAt));
      cellOpen.lastIndex = closeAt + closeTag.length;
    } else {
      cellOpen.lastIndex = tag.end;
    }

    const room = maxColumns - cells.length;
    for (let i = 0; i < Math.min(repeat, room); i++) cells.push(value);
  }

  return cells;
}

/** Split a buffer into complete row elements, returning the unconsumed tail. */
function drainRows(buffer: string): { rows: string[]; rest: string } {
  const rows: string[] = [];
  let cursor = 0;
  for (;;) {
    const end = buffer.indexOf(ROW_END, cursor);
    if (end === -1) break;
    const segment = buffer.slice(cursor, end);
    ROW_OPEN.lastIndex = 0;
    let start = -1;
    let m: RegExpExecArray | null;
    while ((m = ROW_OPEN.exec(segment)) !== null) start = m.index;
    if (start !== -1) rows.push(segment.slice(start));
    cursor = end + ROW_END.length;
  }
  return { rows, rest: buffer.slice(cursor) };
}

export type ReadOdsOptions = {
  /** Header is located by name: the first row containing all of these. Column
   *  positions shift between CQC releases, so index-based access would rot. */
  requiredColumns: string[];
  maxColumns?: number;
};

/**
 * Stream the rows of an .ods file as objects keyed by header name, skipping
 * everything before the header row.
 */
export async function* readOdsRows(
  odsPath: string,
  options: ReadOdsOptions,
): AsyncGenerator<OdsRow> {
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const proc = Bun.spawn(['unzip', '-p', odsPath, 'content.xml'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const decoder = new TextDecoder();
  let buffer = '';
  let header: string[] | null = null;

  try {
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const { rows, rest } = drainRows(buffer);
      buffer = rest;

      for (const rowXml of rows) {
        const cells = parseOdsRowCells(rowXml, maxColumns);
        if (!header) {
          const hasAll = options.requiredColumns.every((c) =>
            cells.includes(c),
          );
          if (hasAll) header = cells;
          continue;
        }
        const row: OdsRow = {};
        for (let i = 0; i < header.length; i++) {
          const key = header[i];
          if (key && row[key] === undefined) row[key] = cells[i] ?? '';
        }
        yield row;
      }
    }
  } finally {
    proc.kill();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0 && exitCode !== 143) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`unzip failed on ${odsPath} (exit ${exitCode}): ${err}`);
  }
  if (!header) {
    throw new Error(
      `No header row in ${odsPath} containing: ${options.requiredColumns.join(', ')}`,
    );
  }
}
