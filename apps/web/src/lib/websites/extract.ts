/**
 * Looks for proof of identity on a fetched page. No I/O.
 *
 * The question is never "what company number is on this page?" but "is THIS
 * company's number on this page?", which is a far narrower and safer thing to
 * ask. We already know the number from the Companies House join, so there is no
 * need to extract arbitrary candidates and then decide whether to believe them
 * — we search for the specific value and its handful of legitimate renderings.
 *
 * The evidence exists because UK companies are required to publish it:
 * Companies Act 2006 s.82 and SI 2015/17 reg. 25 mandate the registered name,
 * registered number, place of registration and registered office address on a
 * company's website.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hyphen: '-',
};

/** Characters a browser renders as nothing at all. They must go before any
 *  matching, or an invisible soft hyphen inside a company number breaks the
 *  digit run and the disclosure reads as absent. */
const INVISIBLE = /[­​-‍⁠﻿]/g;

/** Decode the character references a disclosure might be written with. Without
 *  this, `&#48;3260168` is not the number 03260168 as far as we are concerned,
 *  though it is to every reader of the page. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (all, entity: string) => {
      if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? all;
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return all;
      return String.fromCodePoint(code);
    },
  );
}

/**
 * Approximate what a reader actually sees.
 *
 * Script and style bodies go first: a number inside an analytics blob or a CSS
 * content string is not a trading disclosure. Then tags, then character
 * references, then the characters that render as nothing.
 *
 * A real browser would do this properly, and `page.innerText()` is the honest
 * version of this function. Measured against Playwright over 60 live company
 * sites, though, a browser surfaced no company number this missed — company
 * registration details live in the footer, which is static site chrome even on
 * a client-rendered site. So this stays regex-based, at roughly a third of the
 * wall-clock, and the browser is kept for the cases that genuinely need one.
 */
function visibleText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    // Inline elements do not interrupt a line, so they leave nothing behind:
    // `<strong>0326</strong>0168` reads as one number to a person and must to
    // us. Every other tag is a line break, which is what stops `M1</p><p>1AE`
    // from reading as the postcode "M1 1AE" — with all tags mapped to a space
    // that fusion matched, and a coincidence promoted a candidate row to
    // verified.
    .replace(
      /<\/?(?:span|b|strong|em|i|u|small|font|label|abbr|a)\b[^>]*>/gi,
      '',
    )
    .replace(/<[^>]+>/g, '\n');
  return decodeEntities(stripped).replace(INVISIBLE, '');
}

/**
 * The renderings of a company number a disclosure may legitimately use. A
 * lettered number is only ever written in full; a numeric one is very often
 * typed without its leading zeros ("Company No. 3260168" for 03260168), which
 * is the same dropped-zero habit the registry importer has to undo.
 */
export function companyNumberVariants(companyNumber: string): string[] {
  const canonical = companyNumber.trim().toUpperCase();
  if (!canonical) return [];
  const variants = new Set([canonical]);
  if (/^\d{8}$/.test(canonical)) {
    const stripped = canonical.replace(/^0+/, '');
    // Seven digits, i.e. at most ONE dropped zero — which is the habit this
    // exists for ("Company No. 3260168" for 03260168). Going shorter turns any
    // bare numeral on the page into proof of registration: with a 4-digit floor
    // an extension number, a product code or a year matched, and because
    // crn_on_page sits at the top of the ladder that promotion is permanent.
    if (stripped.length >= 7) variants.add(stripped);
  }
  return [...variants];
}

/** Escape a literal for embedding in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether this company's registered number appears in the page's visible text.
 *
 * Word-bounded, so 03260168 is not found inside 103260168. The bounds also make
 * the two variants non-overlapping: searching for the zero-stripped 3260168
 * cannot match within the full 03260168, because there is no word boundary
 * between the two digits, so a page carrying only the padded form is still
 * matched by the padded variant rather than accidentally by the stripped one.
 */
export function pageHasCompanyNumber(
  html: string,
  companyNumber: string,
): boolean {
  const variants = companyNumberVariants(companyNumber);
  if (variants.length === 0) return false;
  const text = visibleText(html).toUpperCase();
  return variants.some((variant) =>
    new RegExp(`\\b${escapeRegExp(variant)}\\b`).test(text),
  );
}

/**
 * Whether this company's registered office postcode appears in the page's
 * visible text.
 *
 * Weaker than the number and used only when the number is absent: the same
 * regulations require the registered office address, and a postcode survives on
 * sites that omit the number. Compared with whitespace removed, since
 * "SW1A 1AA", "SW1A1AA" and "sw1a  1aa" are one postcode.
 */
export function pageHasPostcode(html: string, postcode: string): boolean {
  const needle = postcode.replace(/\s+/g, '').toUpperCase();
  // Below this a "postcode" is too short to be distinctive enough to trust.
  if (needle.length < 5) return false;

  // Whitespace is COLLAPSED, never removed. Removing it page-wide let a needle
  // be assembled from fragments that are never adjacent to a reader: with
  // `<p>Ref M1</p><p>1AEX warehouse</p>`, stripping every space produced
  // "...M11AEX..." and "M1 1AE" matched a coincidence. A postcode's inward and
  // outward codes are separated by at most one space, so that is all we allow,
  // and the match is bounded so it cannot start or end mid-token.
  // Spaces and tabs collapse; a newline is a block boundary and must survive,
  // or the fusion this guards against comes straight back.
  const text = visibleText(html)
    .replace(/[^\S\n]+/g, ' ')
    .toUpperCase();
  const split = needle.length - 3;
  const pattern = `${escapeRegExp(needle.slice(0, split))} ?${escapeRegExp(needle.slice(split))}`;
  return new RegExp(`(?<![A-Z0-9])${pattern}(?![A-Z0-9])`).test(text);
}
