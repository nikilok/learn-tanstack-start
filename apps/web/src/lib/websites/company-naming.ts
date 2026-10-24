/**
 * Whether a site names the company a postcode match is about. No I/O.
 *
 * A postcode identifies an address, not a company: a contractor's on-site
 * office, a neighbour in the same business centre and another company
 * registered at the same office all show it. So a postcode only proves a site
 * when the page showing it names the company, by its host or in its text:
 * by its registered name, or a name the sponsor register lists for it.
 */

import { parseHmrcName } from '../hmrc-ch/pipeline';

/** The names a site may use for a company. */
export type CompanyNames = {
  /** Companies House name. */
  companyName: string;
  /** Sponsor-register entries for the company, trading names included. */
  sponsorNames: readonly string[];
};

/** Legal forms: what kind of company a name is. */
const LEGAL_FORMS = ['LIMITED', 'LTD', 'PLC', 'LLP', 'LLC', 'CIC', 'INC'];

/** Form words: legal forms and UK, left off a name as written. */
const FORM = new Set([...LEGAL_FORMS, 'UK']);

/** Words that say what kind of company it is, never which one. */
const LEGAL = new Set([...FORM, 'CO', 'COMPANY', 'THE', 'AND', 'OF']);

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

/** Second-level labels a domain is registered under, as in co.uk, com.au or uk.com. */
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
  'uk',
]);

/** A name's words, upper-cased, `&` read as AND. */
function tokens(companyName: string): string[] {
  return companyName
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Whether a word can say which company it is: neither legal nor generic. */
function identifying(word: string): boolean {
  return !LEGAL.has(word) && !GENERIC.has(word);
}

/** The words that say which company it is: three letters or more, neither legal nor generic. */
export function nameWords(companyName: string): string[] {
  return tokens(companyName).filter(
    (word) => word.length >= 3 && identifying(word),
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

/** The domain a host is registered under: acme.co.uk for shop.acme.co.uk, myshopify.com for acme.myshopify.com. */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const suffix =
    labels.length > 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 2 : 1;
  return labels.slice(-(suffix + 1)).join('.');
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

/** A sponsor-register entry's names, legal and trading, split as the HMRC mapping splits them. */
export function registerNames(organisationName: string): string[] {
  const parsed = parseHmrcName(organisationName);
  if (parsed.parsedTrading) return parsed.candidates;
  // A trading name the parser's spellings miss: ACME LTD.T/A ACME DENTAL.
  return parsed.parsedLegal
    .split(/\bt\s*\/\s*a\b:?|\btrading\s+as\b:?/i)
    .map((part) => part.replace(/^[\s(),.]+|[\s(),]+$/g, ''))
    .filter((part) => tokens(part).length > 0);
}

/** A name's words as a site writes it: no bracketed qualifier, trailing form words or leading THE. */
function writtenName(name: string): string[] {
  const words = tokens(
    name.replace(/\([^)]*\)/g, ' ').replace(/\bU\.\s?K\b\.?/gi, ' UK '),
  );
  while (words.length > 0 && FORM.has(words[words.length - 1])) words.pop();
  return words[0] === 'THE' ? words.slice(1) : words;
}

/** The register's names for the company, once each, bar its registered name. */
function registerNamesOf(names: CompanyNames): string[] {
  const seen = new Set([writtenName(names.companyName).join(' ')]);
  return names.sponsorNames.flatMap(registerNames).filter((name) => {
    const key = writtenName(name).join(' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A host's labels as a whole name may fill them: joined or split at hyphens, with and without THE or a trailing form word. */
function wholeLabels(host: string): Set<string> {
  const labels = new Set<string>();
  const add = (label: string) => {
    labels.add(label);
    // qxassociatesltd and qx-associates-uk spell the registered name in full.
    for (const form of FORM) {
      if (label.length > form.length && label.endsWith(form)) {
        add(label.slice(0, -form.length));
      }
    }
  };
  for (const own of ownLabels(host)) {
    for (const part of [own.replace(/-/g, ''), ...own.split('-')]) {
      const label = part.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!label) continue;
      add(label);
      if (label.startsWith('THE') && label.length > 3) add(label.slice(3));
    }
  }
  return labels;
}

/** Whether a domain label is the whole name run together: qx-associates for QX ASSOCIATES LTD. */
export function hostIsWholeName(host: string, name: string): boolean {
  const words = writtenName(name);
  if (!words.some(identifying)) return false;
  return wholeLabels(host).has(words.join(''));
}

/** Whether a domain carries a register name: whole, or opening a label up to its second word that says which company it is. */
function hostCarriesRegisterName(host: string, name: string): boolean {
  if (hostIsWholeName(host, name)) return true;
  // Never by one word or by initials: premierdental is not PREMIER, and
  // clinic4u is not ELMBANK CHIROPRACTIC CLINIC.
  const words = writtenName(name);
  const isNameWord = (word: string) => word.length >= 3 && identifying(word);
  const first = words.findIndex(isNameWord);
  const second =
    first < 0
      ? -1
      : words.findIndex((word, i) => i > first && isNameWord(word));
  if (second < 0) return false;
  const lead = words.slice(0, second + 1).join('');
  return [...wholeLabels(host)].some((label) => label.startsWith(lead));
}

/** What a page may put between a name's words: up to two of a space, dot, apostrophe, ampersand, slash or dash. */
const BETWEEN = "[ .'’&/\\-‐‑–—]{0,2}";

/** A legal form closing a registered name on a page, after its own bracketed qualifier or UK. */
const LEGAL_TAIL = `${BETWEEN}(?:\\([^)]{1,40}\\)${BETWEEN})?(?:UK${BETWEEN})?(?:${LEGAL_FORMS.join('|')})\\b`;

/** A page's visible text as phrases are matched against it: upper-cased, every run of whitespace one space. */
function phrasePage(text: string): string {
  return text.toUpperCase().replace(/\s+/g, ' ');
}

/** Whether the page has the words as one phrase, bounded at both ends and followed by `tail`. */
function hasPhrase(page: string, words: readonly string[], tail = ''): boolean {
  if (words.length === 0) return false;
  const phrase = words
    .map((word) => (word === 'AND' ? '(?:AND|&)' : word))
    .join(BETWEEN);
  return new RegExp(`(?<![A-Z0-9])${phrase}${tail}(?![A-Z0-9])`).test(page);
}

/** Whether a page, as phrasePage leaves it, writes the name whole and closed by its legal form. */
function carriesWholeName(page: string, name: string): boolean {
  const words = writtenName(name);
  return words.some(identifying) && hasPhrase(page, words, LEGAL_TAIL);
}

/** Whether a page writes the registered name whole, closed by its legal form: Angelcare PLC for ANGEL CARE PLC. */
export function pageHasWholeName(text: string, name: string): boolean {
  return carriesWholeName(phrasePage(text), name);
}

/** Whether a register name is a legal name, closed by its legal form: Acme Ltd, never its trading name Acme Dental. */
function isLegalName(name: string): boolean {
  return LEGAL_FORMS.includes(tokens(name).at(-1) ?? '');
}

/** Whether a page writes a register name whole: a legal name closed by its form, or two words that say which company it is, as one phrase. */
function pageCarriesRegisterName(page: string, name: string): boolean {
  if (isLegalName(name) && carriesWholeName(page, name)) return true;
  return nameWords(name).length >= 2 && hasPhrase(page, writtenName(name));
}

/** Whether a host names the company, given the register's names for it. */
function hostNames(
  host: string,
  names: CompanyNames,
  register: readonly string[],
): boolean {
  return (
    hostNamesCompany(host, names.companyName) ||
    hostIsWholeName(host, names.companyName) ||
    register.some((name) => hostCarriesRegisterName(host, name))
  );
}

/** Whether a host names the company, by its registered name or a name the sponsor register lists: the register read once, each host's answer kept. */
export function hostNamer(names: CompanyNames): (host: string) => boolean {
  const register = registerNamesOf(names);
  const answers = new Map<string, boolean>();
  return (host) => {
    let named = answers.get(host);
    if (named === undefined) {
      named = hostNames(host, names, register);
      answers.set(host, named);
    }
    return named;
  };
}

/** Whether a fetched page names the company: by the host that served it, or in its text. */
export function namesCompany(
  servedHost: string,
  text: string,
  names: CompanyNames,
): boolean {
  const register = registerNamesOf(names);
  // The serving host, not the one asked for: a named domain that redirects
  // to another business serves that business's page. Hosts first: they cost
  // nothing next to reading the page.
  if (hostNames(servedHost, names, register)) return true;
  const page = phrasePage(text);
  return (
    pageNamesCompany(page, names.companyName) ||
    carriesWholeName(page, names.companyName) ||
    register.some((name) => pageCarriesRegisterName(page, name))
  );
}

/** Slack, in words, for what a page puts between a name's words: "Acme & Co Widgets". */
const NAME_SPAN_SLACK = 3;

/** A page's words, upper-cased. */
function pageTokens(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Whether every word appears within one span of the page, starting at one of them. */
function wordsTogether(
  page: readonly string[],
  words: readonly string[],
): boolean {
  if (words.length === 0) return false;
  // Together, as a name is written: ROSE in one listing and BAKERY in
  // another are not ROSE BAKERY.
  const span = words.length + NAME_SPAN_SLACK;
  return page.some(
    (token, i) =>
      words.includes(token) &&
      words.every((word) => page.slice(i, i + span).includes(word)),
  );
}

/** Whether a page's visible text names the company: every word that says which company it is, together. */
export function pageNamesCompany(text: string, companyName: string): boolean {
  return wordsTogether(pageTokens(text), nameWords(companyName));
}
