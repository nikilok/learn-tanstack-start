// When a typed search may be asked as a question: after the name search it
// ran has come back empty, and only then.

/** A search shorter than this is never asked: one or two words are a name that is not on the register, not a description. */
export const MIN_ASK_WORDS = 3;

/** The longest text a search is planned for, in code points; the server refuses more, so the box never offers it. */
export const MAX_QUESTION_CHARS = 300;

/** The words in a search, as the floor counts them. */
export function askWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Whether `text` only adds to a prefix the offer stood on. Its own name
 * search still runs (a word added can lift a fuzzy match over the line: the
 * similarity is over the whole string, not its prefix), but the offer stays
 * up while it does, so the box never flickers for a word added to an empty
 * text.
 */
export function extendsEmptyPrefix(
  text: string,
  prefix: string | null,
): boolean {
  return (
    prefix !== null && text.length > prefix.length && text.startsWith(prefix)
  );
}

/**
 * Whether the search box may offer to ask. `confirmedEmpty` is the name
 * search's settled verdict on exactly this `text`; `ready` says the offer can
 * be taken (access known open, or a device able to mint a token); the
 * /download preview never asks, as with every other call it stays out of.
 */
export function askEligible({
  confirmedEmpty,
  text,
  ready,
  preview,
}: {
  confirmedEmpty: boolean;
  text: string;
  ready: boolean;
  preview: boolean;
}): boolean {
  return (
    confirmedEmpty &&
    ready &&
    !preview &&
    askWordCount(text) >= MIN_ASK_WORDS &&
    [...text].length <= MAX_QUESTION_CHARS
  );
}
