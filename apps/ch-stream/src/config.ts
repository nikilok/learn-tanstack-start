export const CONFIG = {
  STREAM_URL: 'https://stream.companieshouse.gov.uk/companies',
  POSTGRES_URL: process.env.POSTGRES_URL ?? '',
  API_KEY: process.env.COMPANIES_HOUSE_STREAM_API_KEY ?? '',
  REVALIDATE_URL: process.env.REVALIDATE_URL ?? '',
  REVALIDATE_SECRET: process.env.REVALIDATE_SECRET ?? '',
  RETRY_DELAY_429_MS: 60_000,
  RECONNECT_DELAY_MS: 5_000,
  TIMEPOINT_FLUSH_INTERVAL: 100,
} as const;

export function validateConfig() {
  if (!CONFIG.POSTGRES_URL) throw new Error('POSTGRES_URL is required');
  if (!CONFIG.API_KEY)
    throw new Error('COMPANIES_HOUSE_STREAM_API_KEY is required');
  if (!CONFIG.REVALIDATE_URL)
    console.warn(
      '[ch-stream] REVALIDATE_URL not set — cache revalidation disabled',
    );
  if (!CONFIG.REVALIDATE_SECRET)
    console.warn(
      '[ch-stream] REVALIDATE_SECRET not set — cache revalidation disabled',
    );
}
