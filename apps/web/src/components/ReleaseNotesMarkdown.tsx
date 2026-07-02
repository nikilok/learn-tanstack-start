import { Fragment } from 'react';
import type { ReactNode } from 'react';

// Deliberately tiny subset renderer — release notes are self-authored in the
// dispatch form, so a full markdown dependency tree isn't warranted. Emits
// React nodes only (no raw HTML), so unsupported syntax degrades to plain text.

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'p'; lines: string[] };

// Flanked emphasis content: no space just inside either delimiter, so
// '2 * 3 * 4' and glob patterns like '*.ts' stay literal.
const EMPH_SRC = String.raw`[^\s*](?:[^*]*[^\s*])?`;
// URL with one level of balanced parens (Wikipedia-style paths).
const URL_SRC = String.raw`[^()\s]*(?:\([^()\s]*\)[^()\s]*)*`;
const INLINE = new RegExp(
  `(\\*\\*\\*${EMPH_SRC}\\*\\*\\*` +
    `|\\*\\*${EMPH_SRC}\\*\\*` +
    `|\\*${EMPH_SRC}\\*` +
    '|`[^`]+`' +
    `|\\[[^\\]]+\\]\\(${URL_SRC}\\))`,
  'g',
);
const LINK_TOKEN = new RegExp(`^\\[([^\\]]+)\\]\\((${URL_SRC})\\)$`);

/** Renders one matched inline token (bold/italic, code, or link), recursing into its content. */
function inlineToken(token: string, key: number): ReactNode {
  if (token.startsWith('***'))
    return (
      <strong key={key}>
        <em>{renderInline(token.slice(3, -3))}</em>
      </strong>
    );
  if (token.startsWith('**'))
    return <strong key={key}>{renderInline(token.slice(2, -2))}</strong>;
  if (token.startsWith('*'))
    return <em key={key}>{renderInline(token.slice(1, -1))}</em>;
  if (token.startsWith('`'))
    return (
      <code
        key={key}
        className="rounded bg-(--sponsor-card-bg) px-1 py-0.5 text-[0.85em]"
      >
        {token.slice(1, -1)}
      </code>
    );
  const link = LINK_TOKEN.exec(token);
  if (link && /^https?:\/\//i.test(link[2]))
    return (
      <a
        key={key}
        href={link[2]}
        target="_blank"
        rel="noreferrer"
        className="text-(--link-blue) underline"
      >
        {renderInline(link[1])}
      </a>
    );
  return token;
}

/** Splits a line of text into React nodes, resolving inline markdown. */
function renderInline(text: string): ReactNode[] {
  // split() with one capture group alternates plain text (even) / token (odd).
  return text
    .split(INLINE)
    .map((part, i) => (i % 2 ? inlineToken(part, i) : part));
}

/** Groups markdown source lines into block-level chunks. */
function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let fenceLen = 0;
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (current?.kind === 'code') {
      // Close only on a bare fence at least as long as the opener (CommonMark).
      const close = /^(`{3,})$/.exec(line.trim());
      if (close && close[1].length >= fenceLen) current = null;
      else current.lines.push(raw);
      continue;
    }
    const fence = /^(`{3,})/.exec(line.trim());
    if (fence) {
      fenceLen = fence[1].length;
      current = { kind: 'code', lines: [] };
      blocks.push(current);
      continue;
    }
    if (!line.trim()) {
      current = null; // blank line closes the open paragraph/list
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        // Strip a closed-ATX trailing hash run ('## Improvements ##').
        text: heading[2].replace(/\s+#+$/, ''),
      });
      current = null;
      continue;
    }
    // One rule for both list kinds; leading indent flattens nested items into
    // the open list instead of splitting it around a raw-text paragraph.
    const list = /^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (list) {
      const kind = list[1] === undefined ? 'ul' : 'ol';
      const num = list[1] ? parseInt(list[1], 10) : 1;
      // CommonMark: only a 1-numbered item may interrupt a paragraph — keeps
      // hard-wrapped prose like '…in\n2024. It was…' out of a bogus <ol>.
      if (kind === 'ol' && current?.kind === 'p' && num !== 1) {
        current.lines.push(line);
        continue;
      }
      // Written as !current || … : `current?.kind !== kind` trips a TS CFA
      // quirk (optional chain vs union-typed comparand) that infers `never`.
      if (!current || current.kind !== kind) {
        current =
          kind === 'ul' ? { kind, items: [] } : { kind, start: num, items: [] };
        blocks.push(current);
      }
      current.items.push(list[2]);
      continue;
    }
    if (current?.kind !== 'p') {
      current = { kind: 'p', lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-base font-semibold text-(--sea-ink)',
  2: 'text-sm font-semibold text-(--sea-ink)',
  3: 'text-sm font-medium text-(--sea-ink)',
};

/** Renders one parsed block as its element. */
function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading':
      // h3 regardless of markdown level — the page's own outline ends at the
      // DownloadCard h2, so anything deeper would skip a level.
      return (
        <h3 key={key} className={HEADING_CLASS[block.level]}>
          {renderInline(block.text)}
        </h3>
      );
    case 'ul':
    case 'ol': {
      const items = block.items.map((item, i) => (
        <li key={i}>{renderInline(item)}</li>
      ));
      return block.kind === 'ul' ? (
        <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
          {items}
        </ul>
      ) : (
        <ol
          key={key}
          start={block.start === 1 ? undefined : block.start}
          className="flex list-decimal flex-col gap-1 pl-5"
        >
          {items}
        </ol>
      );
    }
    case 'code':
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-md border border-(--line) bg-(--sponsor-card-bg) p-3 text-xs"
        >
          <code>{block.lines.join('\n')}</code>
        </pre>
      );
    case 'p':
      return (
        <p key={key}>
          {block.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      );
  }
}

/** Markdown subset for release notes: #–### headings, -/1. lists, ``` fences, bold/italic/code/https-links. */
export function ReleaseNotesMarkdown({ source }: { source: string }) {
  return (
    <div className="mt-2 flex flex-col gap-2 text-sm text-(--sea-ink-soft)">
      {parseBlocks(source).map(renderBlock)}
    </div>
  );
}
