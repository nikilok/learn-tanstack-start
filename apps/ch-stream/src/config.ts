export const CONFIG = {
  STREAM_URL: 'https://stream.companieshouse.gov.uk/companies',
  POSTGRES_URL: process.env.POSTGRES_URL ?? '',
  API_KEY: process.env.COMPANIES_HOUSE_STREAM_API_KEY ?? '',
  RETRY_DELAY_429_MS: 60_000,
  RECONNECT_DELAY_MS: 5_000,
  TIMEPOINT_FLUSH_INTERVAL: 100,
} as const;

export function validateConfig() {
  if (!CONFIG.POSTGRES_URL) throw new Error('POSTGRES_URL is required');
  if (!CONFIG.API_KEY)
    throw new Error('COMPANIES_HOUSE_STREAM_API_KEY is required');
}
