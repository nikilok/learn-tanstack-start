// Model-response parsing + prompt formatting for the HMRC CSV discovery agent.
// Extracted from find-hmrc-csv-url.ts (which runs main() on import) so the
// parsing that the scheduled ingestion depends on is unit-testable.

export interface AgentAction {
  action: 'click' | 'done';
  url?: string;
  csvUrl?: string;
  reasoning: string;
}

export interface PageLink {
  text: string;
  href: string;
}

/** Returns the balanced {...} starting at `start`, or null if it never closes. */
function scanObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extracts the first parseable JSON object from a model response, tolerating
 * code fences, surrounding prose, and multiple candidate objects.
 */
export function parseAgentAction(text: string, label = 'Model'): AgentAction {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const raw = scanObject(text, i);
    if (raw) {
      try {
        return JSON.parse(raw) as AgentAction;
      } catch {
        // Balanced but not JSON (e.g. prose braces) — try the next candidate.
      }
    }
  }
  throw new Error(`${label} did not return valid JSON: ${text}`);
}

/** Formats scraped links for the prompt; filtered + compact for Gemma's 8k context. */
export function formatLinksForPrompt(
  links: PageLink[],
  provider: string,
): string {
  if (provider !== 'gemma') return JSON.stringify(links, null, 2);
  const relevant = links.filter((l) =>
    /csv|sponsor|worker|licen[cs]|register|immigration|visa|download/i.test(
      `${l.text} ${l.href}`,
    ),
  );
  const pool = (relevant.length > 0 ? relevant : links)
    .map((l) => ({ text: l.text.slice(0, 100), href: l.href }))
    .sort(
      (a, b) =>
        Number(b.href.includes('.csv')) - Number(a.href.includes('.csv')),
    );
  return JSON.stringify(pool.slice(0, 120));
}
