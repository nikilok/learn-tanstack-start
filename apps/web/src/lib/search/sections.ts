/** Canonical /filters section list — single source for accordion order/titles, the hero facet chips, and the filters ItemList schema labels (`schemaLabel: null` = non-filter section, excluded from chips and schema). Ids mirror SECTION_KEYS in routes/filters.tsx, compile-pinned there. */
export const FILTER_SECTIONS = [
  { id: 'route', title: 'Visa route', schemaLabel: 'Visa route' },
  {
    id: 'licence',
    title: 'Licence',
    schemaLabel: 'Sponsor licence rating and worker type',
  },
  { id: 'location', title: 'Location', schemaLabel: 'City or town' },
  { id: 'industry', title: 'Industry', schemaLabel: 'Industry or SIC code' },
  { id: 'status', title: 'Company status', schemaLabel: 'Company status' },
  { id: 'companyType', title: 'Company type', schemaLabel: 'Company type' },
  {
    id: 'incorporated',
    title: 'Incorporated',
    schemaLabel: 'Incorporation date',
  },
  {
    id: 'signals',
    title: 'Signals',
    schemaLabel:
      'Change signals: renames, office moves, charges, insolvency, overdue accounts',
  },
  { id: 'sort', title: 'Sort', schemaLabel: null },
] as const;
