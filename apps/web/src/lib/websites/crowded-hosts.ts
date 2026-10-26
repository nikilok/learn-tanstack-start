/**
 * Result hosts search returns for many different companies: directories,
 * registers and platforms, listed or not. No I/O.
 */

import { isAggregatorExempt, isAggregatorHost } from './page-signals';

/** Companies a host must appear for to count as a directory; 99.9% of proven own sites appear for fewer. */
export const CROWDED_HOST_COMPANIES = 50;

/** Platforms that give each business a subdomain of their own: site builders and hosts, a donation platform, booking pages, careers platforms, directories. Never schools', the NHS's or universities' shared domains, whose subdomains are their own sites. */
export const PLATFORM_DOMAINS = [
  // Site builders and hosts.
  'wordpress.com',
  'ueniweb.com',
  'wixsite.com',
  'blogspot.com',
  'square.site',
  'squarespace.com',
  'weebly.com',
  'webflow.io',
  'myshopify.com',
  'godaddysites.com',
  'mystrikingly.com',
  'strikingly.com',
  'site123.me',
  'webnode.page',
  'jimdosite.com',
  'yolasite.com',
  'carrd.co',
  'business.site',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'github.io',
  'herokuapp.com',
  'amazonaws.com',
  'ghost.io',
  'tumblr.com',
  'substack.com',
  'fandom.com',
  'bandcamp.com',
  // A donation platform.
  'raiselysite.com',
  // Booking pages.
  'setmore.com',
  'janeapp.co.uk',
  'mytreatwell.co.uk',
  // Careers platforms, which host a business's jobs pages.
  'teamtailor.com',
  'pinpointhq.com',
  'softgarden.de',
  'personio.de',
  'personio.com',
  'workable.com',
  'greenhouse.io',
  'lever.co',
  'recruitee.com',
  'smartrecruiters.com',
  'bamboohr.com',
  'myworkdayjobs.com',
  'icims.com',
  'jobvite.com',
  'breezy.hr',
  'applytojob.com',
  'ashbyhq.com',
  'hirehive.com',
  // Directories that give each business a subdomain.
  'wheree.com',
  'opendi.co.uk',
  'open-closed.co.uk',
  'maptons.com',
  'hotels-of-london.com',
  'restaurants-us.com',
];

/** Whether a host is a business's page on a shared platform rather than a site of its own. */
export function isPlatformPage(host: string): boolean {
  const clean = crowdKey(host);
  return PLATFORM_DOMAINS.some(
    (domain) => clean === domain || clean.endsWith(`.${domain}`),
  );
}

/** The form hosts are counted under: lower-case, without a leading `www.`. */
export function crowdKey(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** Whether discovery should pass over a host: listed, crowded, or a platform's page. */
export function isDiscoveryAggregator(
  host: string,
  crowded: ReadonlySet<string>,
): boolean {
  if (isAggregatorExempt(host)) return false;
  return (
    isAggregatorHost(host) ||
    crowded.has(crowdKey(host)) ||
    isPlatformPage(host)
  );
}
