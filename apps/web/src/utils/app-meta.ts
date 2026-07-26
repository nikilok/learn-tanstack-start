// Single source for the product title — document titles (__root.tsx) and the
// /download preview chrome both key off it.
export const APP_NAME = 'Skilled Worker Sponsor Search';

// Short product/brand name — og:site_name, PWA names, and JSON-LD schema.
export const APP_SHORT_NAME = 'SponsorSearch';

// Home document/og title. Leads with the "UK sponsor search" phrasing while
// keeping the "sponsor search" and "skilled worker visa sponsors" phrases
// intact — word-order permutations searchers actually type.
export const APP_TITLE = 'UK Sponsor Search — Skilled Worker Visa Sponsors';

// Site-wide meta description (__root.tsx + WebSite JSON-LD). manifest.json
// keeps a static copy — update both together.
export const APP_DESCRIPTION =
  'Free UK sponsor search — every licensed Skilled Worker visa sponsor in the UK. Filter the Home Office register by city, industry, visa route or rating.';
