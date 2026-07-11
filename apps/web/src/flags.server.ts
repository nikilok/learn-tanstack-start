import { createVercelAdapter } from '@flags-sdk/vercel';
import { createClient } from '@vercel/flags-core';
import { decryptOverrides } from 'flags';

/** Minimal flag spec — kept framework-agnostic so the same declaration is consumed by the discovery endpoint metadata and the server-side evaluator. */
export type FlagSpec<T> = {
  key: string;
  description: string;
  defaultValue: T;
  options: { value: T; label: string }[];
};

/** Serializable value a flag resolves to — limited to JSON primitives because the discovery endpoint exposes flag definitions as JSON (and any future client-side flag bridge must serialize them too). */
export type FlagValue = boolean | string | number;

/** Cookie the Vercel toolbar's Flags Explorer writes signed overrides into. */
export const FLAG_OVERRIDES_COOKIE = 'vercel-flag-overrides';

/** Decrypts the signed Flags Explorer override cookie; null when absent, tampered, or expired. */
export async function decryptFlagOverrides(
  cookieValue: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!cookieValue) return null;
  try {
    return (
      ((await decryptOverrides(
        cookieValue,
        process.env.FLAGS_SECRET,
      )) as Record<string, unknown>) ?? null
    );
  } catch {
    return null;
  }
}

/** No-op anchor flag — load-bearing: the Flags Explorer only mints the `vercel-flag-overrides` cookie (which owner.server.ts upgrades to the durable ss-owner credential) when ≥1 flag exists, so an empty registry silently breaks new-owner bootstrap. Gates no UI; do NOT delete as "unused". */
export const ownerBootstrapFlag: FlagSpec<boolean> = {
  key: 'owner-bootstrap',
  description:
    'Anchor for owner bootstrap — toggle + Apply in the Flags Explorer to mint the overrides cookie owner.server.ts upgrades to ss-owner. Gates no UI.',
  defaultValue: false,
  options: [
    { value: false, label: 'Off' },
    { value: true, label: 'On' },
  ],
};

/** Active flag registry. Add a FlagSpec here and the discovery endpoint exposes it to the Flags Explorer automatically; resolve values at the call site with evaluateFlag. */
export const flags: Record<string, FlagSpec<FlagValue>> = {
  [ownerBootstrapFlag.key]: ownerBootstrapFlag,
};

/** Memoized adapter factory; null when FLAGS is unset (e.g. local dev without Vercel Flags). */
let adapterFactory: ReturnType<typeof createVercelAdapter> | null | undefined;

/** Returns the Vercel Flags adapter on a polling-mode client (`stream: false`): SSE stream init from a serverless function stalls the first evaluation per instance ~2.5s. Polling's first datafile fetch is bounded (3s timeout), then a 30s background interval keeps warm instances fresh — flag flips propagate within ~30s instead of live. */
function getAdapterFactory() {
  if (adapterFactory === undefined) {
    adapterFactory = process.env.FLAGS
      ? createVercelAdapter(createClient(process.env.FLAGS, { stream: false }))
      : null;
  }
  return adapterFactory;
}

/** Resolves a flag server-side: a signed Flags Explorer override cookie value wins; otherwise the Vercel Flags adapter looks up the dashboard-managed value for this environment. Cookie signatures are verified against FLAGS_SECRET so client tampering invalidates the override. */
export async function evaluateFlag<T>(
  spec: FlagSpec<T>,
  overrideCookieValue: string | undefined,
): Promise<T> {
  const overrides = await decryptFlagOverrides(overrideCookieValue);
  if (overrides && spec.key in overrides) {
    return overrides[spec.key] as T;
  }
  try {
    const factory = getAdapterFactory();
    if (!factory) return spec.defaultValue;
    return await factory<T, unknown>().decide({
      key: spec.key,
      headers: EMPTY_HEADERS,
      cookies: EMPTY_COOKIES,
      defaultValue: spec.defaultValue,
    });
  } catch {
    // Vercel Flags unreachable — fall back to default.
    return spec.defaultValue;
  }
}

type VercelFlagAdapter = ReturnType<ReturnType<typeof createVercelAdapter>>;

const EMPTY_HEADERS = new Headers() as unknown as Parameters<
  VercelFlagAdapter['decide']
>[0]['headers'];

const EMPTY_COOKIES = {
  get: () => undefined,
} as unknown as Parameters<VercelFlagAdapter['decide']>[0]['cookies'];
