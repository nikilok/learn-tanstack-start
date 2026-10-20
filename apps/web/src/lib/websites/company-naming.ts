/**
 * Whether a site names the company a postcode match is about. No I/O.
 *
 * A postcode identifies an address, not a company: a contractor's on-site
 * office, a neighbour in the same business centre and another company
 * registered at the same office all show it. So a postcode only proves a site
 * when the page showing it names the company, by its host or in its text.
 */

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

/** The host's own labels, upper-cased: no `www`, top-level or second-level domain. */
function hostLabels(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels[0] === 'www') labels.shift();
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) {
    labels.pop();
  }
  return labels
    .flatMap((label) => label.split('-'))
    .map((label) => label.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .map((label) =>
      label.startsWith('THE') && label.length > 6 ? label.slice(3) : label,
    )
    .filter(Boolean);
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
  const joined = labels.join('');
  // Three-letter words and initials only at the start of a label, where
  // they are a name rather than letters inside another word.
  const words = nameWords(companyName);
  if (words.some((w) => w.length >= 4 && joined.includes(w))) return true;
  if (
    words.some((w) => w.length === 3 && labels.some((l) => l.startsWith(w)))
  ) {
    return true;
  }
  const kept = tokens(companyName).filter(
    (word) => word !== 'LIMITED' && word !== 'LTD' && word !== 'PLC',
  );
  if (kept.length === 0) return false;
  // A label that is only the first word, or the start of it, is as often
  // another business's domain: london for LONDON CARE LTD.
  const firstWordOnly = (label: string) => kept[0].startsWith(label);
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

/** Whether a fetched page names the company: by the host that served it, or in its text. */
export function namesCompany(
  servedHost: string,
  text: string,
  companyName: string,
): boolean {
  // The serving host, not the one asked for: a named domain that redirects
  // to another business serves that business's page.
  return (
    hostNamesCompany(servedHost, companyName) ||
    pageNamesCompany(text, companyName)
  );
}

/** Whether a page's visible text names the company: every word that says which company it is. */
export function pageNamesCompany(text: string, companyName: string): boolean {
  const words = nameWords(companyName);
  if (words.length === 0) return false;
  const page = ` ${text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  return words.every((word) => page.includes(` ${word} `));
}
