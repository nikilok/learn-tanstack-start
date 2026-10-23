/**
 * Whether a site names the company a postcode match is about. No I/O.
 *
 * A postcode identifies an address, not a company: a contractor's on-site
 * office, a neighbour in the same business centre and another company
 * registered at the same office all show it. So a postcode only proves a site
 * when the page showing it names the company, by its host or in its text:
 * by its registered name, or a name the sponsor register lists for it.
 */

/** The names a site may use for a company. */
export type CompanyNames = {
  /** Companies House name. */
  companyName: string;
  /** Sponsor-register entries for the company, trading names included. */
  sponsorNames: readonly string[];
};

/** Words that say what kind of company it is, never which one. */
const LEGAL = new Set([
  'LIMITED',
  'LTD',
  'PLC',
  'LLP',
  'LLC',
  'CIC',
  'INC',
  'CO',
  'COMPANY',
  'THE',
  'AND',
  'OF',
  'UK',
]);

/** Common enough in company names that matching one says nothing. */
const GENERIC = new Set([
  'ACADEMY',
  'ASSOCIATES',
  'BRITAIN',
  'BRITISH',
  'BUILDING',
  'CAPITAL',
  'CARE',
  'CENTRE',
  'COMPUTER',
  'COMPUTERS',
  'CONSTRUCTION',
  'CONSULTANCY',
  'CONSULTANTS',
  'CONSULTING',
  'CORPORATION',
  'DESIGN',
  'DEVELOPMENT',
  'DEVELOPMENTS',
  'DIGITAL',
  'EDUCATION',
  'ELECTRONIC',
  'ENGINEERING',
  'ENGINEERS',
  'ENGLAND',
  'ENTERPRISES',
  'EUROPE',
  'EUROPEAN',
  'FINANCE',
  'FOOD',
  'FOODS',
  'GLOBAL',
  'GROUP',
  'HEALTH',
  'HEALTHCARE',
  'HOLDING',
  'HOLDINGS',
  'HOMES',
  'HOUSE',
  'INDUSTRIES',
  'INTERACTIVE',
  'INTERNATIONAL',
  'INVESTMENTS',
  'IRELAND',
  'LEISURE',
  'LOGISTICS',
  'LONDON',
  'MANAGEMENT',
  'MEDIA',
  'NETWORK',
  'NETWORKS',
  'NORTHERN',
  'PARTNERS',
  'PARTNERSHIP',
  'PRODUCT',
  'PRODUCTS',
  'PROJECTS',
  'PROPERTIES',
  'PROPERTY',
  'RECRUITMENT',
  'SCHOOLS',
  'SCOTLAND',
  'SERVICE',
  'SERVICES',
  'SOFTWARE',
  'SOLUTIONS',
  'SYSTEM',
  'SYSTEMS',
  'TECHNOLOGIES',
  'TECHNOLOGY',
  'TRADING',
  'TRAINING',
  'TRANSPORT',
  'TRAVEL',
  'WALES',
  'WORLDWIDE',
]);

/** Second-level labels under a country code, as in co.uk or com.au. */
const SECOND_LEVEL = new Set([
  'co',
  'com',
  'org',
  'net',
  'ac',
  'gov',
  'ltd',
  'plc',
  'me',
  'nhs',
  'sch',
]);

/** A name's words, upper-cased, `&` read as AND. */
function tokens(companyName: string): string[] {
  return companyName
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** The words that say which company it is: three letters or more, neither legal nor generic. */
export function nameWords(companyName: string): string[] {
  return tokens(companyName).filter(
    (word) => word.length >= 3 && !LEGAL.has(word) && !GENERIC.has(word),
  );
}

/** First letters of every word but the legal ones: P.L. BLAKE LIMITED is PLB. */
export function nameInitials(companyName: string): string {
  return tokens(companyName)
    .filter((word) => !LEGAL.has(word))
    .map((word) => word[0])
    .join('');
}

/** The host's own labels: no `www`, top-level or second-level domain. */
function ownLabels(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels[0] === 'www') labels.shift();
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) {
    labels.pop();
  }
  return labels;
}

/** The host's own labels, upper-cased and split at hyphens. */
function hostLabels(host: string): string[] {
  return ownLabels(host)
    .flatMap((label) => label.split('-'))
    .map((label) => label.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
    .flatMap((label) =>
      // theplbgroup is PLBGROUP, but thermalenergy is not RMALENERGY: keep both.
      label.startsWith('THE') && label.length > 6
        ? [label, label.slice(3)]
        : [label],
    );
}

/** Length of the prefix two strings share. */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Whether a site's domain carries the company's name, its initials, or the start of it. */
export function hostNamesCompany(host: string, companyName: string): boolean {
  const labels = hostLabels(host);
  if (labels.length === 0) return false;
  // Words and initials only at the start of a label, where they are a name
  // rather than letters inside another word: ROSE is not in primrose.
  const words = nameWords(companyName);
  if (words.some((w) => labels.some((l) => l.startsWith(w)))) return true;
  const kept = tokens(companyName).filter(
    (word) => word !== 'LIMITED' && word !== 'LTD' && word !== 'PLC',
  );
  if (kept.length === 0) return false;
  // The first word that names anything, as the initials read it: not THE.
  const first = kept.find((word) => !LEGAL.has(word)) ?? kept[0];
  // The name up to and including that word: THELONDON for THE LONDON ...
  const lead = kept.slice(0, kept.indexOf(first) + 1).join('');
  // A label that is only the first word, or the start of it, is as often
  // another business's domain: london for LONDON CARE LTD.
  const firstWordOnly = (label: string) =>
    first.startsWith(label) || lead.startsWith(label);
  const initials = nameInitials(companyName);
  if (
    initials.length >= 3 &&
    labels.some((l) => !firstWordOnly(l) && sharedPrefix(l, initials) >= 3)
  ) {
    return true;
  }
  // A domain that is the name's own opening letters: M&G FA at mandg.
  const compact = kept.join('');
  return labels.some(
    (l) => l.length >= 3 && !firstWordOnly(l) && compact.startsWith(l),
  );
}

/** A sponsor-register entry's names: ACME LTD T/A ACME DENTAL is both. */
export function registerNames(organisationName: string): string[] {
  return organisationName
    .split(/\bt\s*\/\s*a\b|\btrading\s+as\b|\|/i)
    .map((part) => part.replace(/^[\s()]+|[\s()]+$/g, ''))
    .filter((part) => tokens(part).length > 0);
}

/** Every name to look for: the registered one first, then the register's, once each. */
function namesOf(names: CompanyNames): string[] {
  const seen = new Set<string>();
  return [
    names.companyName,
    ...names.sponsorNames.flatMap(registerNames),
  ].filter((name) => {
    const key = tokens(name).join(' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Form words a written name drops: SK ASSOCIATES for SK ASSOCIATES LTD. */
const FORM = new Set([
  'LIMITED',
  'LTD',
  'PLC',
  'LLP',
  'LLC',
  'CIC',
  'INC',
  'UK',
]);

/** A name's words as a site writes it: no form words, no leading THE. */
function writtenName(name: string): string[] {
  const words = tokens(name.replace(/\bU\.\s?K\b\.?/gi, 'UK')).filter(
    (word) => !FORM.has(word),
  );
  return words[0] === 'THE' ? words.slice(1) : words;
}

/** Whether a written name says which company it is: not only generic and legal words. */
function distinctive(words: readonly string[]): boolean {
  return words.some((word) => !GENERIC.has(word) && !LEGAL.has(word));
}

/** Whether a domain label is the whole name run together: sk-associates for SK ASSOCIATES LTD. */
export function hostIsWholeName(host: string, name: string): boolean {
  const words = writtenName(name);
  if (!distinctive(words)) return false;
  const whole = words.join('');
  return ownLabels(host).some(
    (label) => label.toUpperCase().replace(/[^A-Z0-9]/g, '') === whole,
  );
}

/** Letters a whole name needs before its phrase on a page means anything: 6A does not. */
const MIN_WHOLE_NAME = 5;

/** Whether a page writes the whole name as one phrase, spaced or run together: Angelcare for ANGEL CARE PLC. */
export function pageHasWholeName(text: string, name: string): boolean {
  const words = writtenName(name);
  if (!distinctive(words) || words.join('').length < MIN_WHOLE_NAME) {
    return false;
  }
  // One separator at most between words, never a line break: a phrase, not
  // two blocks of text that happen to meet.
  const phrase = words
    .map((word) => (word === 'AND' ? '(?:AND|&)' : word))
    .join("[ .'’&-]?");
  return new RegExp(`(?<![A-Z0-9])${phrase}(?![A-Z0-9])`).test(
    text.toUpperCase().replace(/[^\S\n]+/g, ' '),
  );
}

/** Whether a fetched page names the company: by the host that served it, or in its text. */
export function namesCompany(
  servedHost: string,
  text: string,
  names: CompanyNames,
): boolean {
  // The serving host, not the one asked for: a named domain that redirects
  // to another business serves that business's page.
  return namesOf(names).some(
    (name) =>
      hostNamesCompany(servedHost, name) ||
      hostIsWholeName(servedHost, name) ||
      pageNamesCompany(text, name) ||
      pageHasWholeName(text, name),
  );
}

/** Slack, in words, for what a page puts between a name's words: "Acme & Co Widgets". */
const NAME_SPAN_SLACK = 3;

/** Whether a page's visible text names the company: every word that says which company it is, together. */
export function pageNamesCompany(text: string, companyName: string): boolean {
  const words = nameWords(companyName);
  if (words.length === 0) return false;
  const page = text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  // Together, as a name is written: ROSE in one listing and BAKERY in
  // another are not ROSE BAKERY.
  const span = words.length + NAME_SPAN_SLACK;
  return page.some(
    (token, i) =>
      words.includes(token) &&
      words.every((word) => page.slice(i, i + span).includes(word)),
  );
}
