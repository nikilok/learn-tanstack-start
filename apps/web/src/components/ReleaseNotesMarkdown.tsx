import { Fragment } from 'react';
import type { ReactNode } from 'react';

// Deliberately tiny subset renderer — release notes are self-authored in the
// dispatch form, so a full markdown dependency tree isn't warranted. Emits
// React nodes only (no raw HTML), so unsupported syntax degrades to plain text.

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'p'; lines: string[] };

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Renders one matched inline token (bold, italic, code, or link). */
function inlineToken(token: string, key: number): ReactNode {
  if (token.startsWith('**'))
    return <strong key={key}>{token.slice(2, -2)}</strong>;
  if (token.startsWith('*')) return <em key={key}>{token.slice(1, -1)}</em>;
  if (token.startsWith('`'))
    return (
      <code
        key={key}
        className="rounded bg-(--sponsor-card-bg) px-1 py-0.5 text-[0.85em]"
      >
        {token.slice(1, -1)}
      </code>
    );
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
  if (link && /^https?:\/\//.test(link[2]))
    return (
      <a
        key={key}
        href={link[2]}
        target="_blank"
        rel="noreferrer"
        className="text-(--link-blue) underline"
      >
        {link[1]}
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
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (current?.kind === 'code') {
      if (line.trim() === '```') current = null;
      else current.lines.push(raw);
      continue;
    }
    if (line.trim().startsWith('```')) {
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
        text: heading[2],
      });
      current = null;
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (current?.kind !== 'ul') {
        current = { kind: 'ul', items: [] };
        blocks.push(current);
      }
      current.items.push(ul[1]);
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (current?.kind !== 'ol') {
        current = { kind: 'ol', items: [] };
        blocks.push(current);
      }
      current.items.push(ol[1]);
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
      // h4 regardless of markdown level — the page's own hierarchy ends at h3.
      return (
        <h4 key={key} className={HEADING_CLASS[block.level]}>
          {renderInline(block.text)}
        </h4>
      );
    case 'ul':
    case 'ol': {
      const Tag = block.kind;
      const style = block.kind === 'ul' ? 'list-disc' : 'list-decimal';
      return (
        <Tag key={key} className={`${style} flex flex-col gap-1 pl-5`}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </Tag>
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
