import { vercelAdapter } from '@flags-sdk/vercel';
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

/** Active flag registry — empty until the next experiment. Add a FlagSpec here and the discovery endpoint exposes it to the Flags Explorer automatically; resolve values at the call site with evaluateFlag. */
export const flags: Record<string, FlagSpec<FlagValue>> = {};

/** Resolves a flag server-side: a signed Flags Explorer override cookie value wins; otherwise the Vercel Flags adapter looks up the dashboard-managed value for this environment. Cookie signatures are verified against FLAGS_SECRET so client tampering invalidates the override. */
export async function evaluateFlag<T>(
  spec: FlagSpec<T>,
  overrideCookieValue: string | undefined,
): Promise<T> {
  if (overrideCookieValue) {
    try {
      const overrides = await decryptOverrides(
        overrideCookieValue,
        process.env.FLAGS_SECRET,
      );
      if (overrides && spec.key in overrides) {
        return overrides[spec.key] as T;
      }
    } catch {
      // Tampered/expired cookie — fall through to dashboard value.
    }
  }
  try {
    const adapter = vercelAdapter<T, unknown>();
    return await adapter.decide({
      key: spec.key,
      headers: EMPTY_HEADERS,
      cookies: EMPTY_COOKIES,
      defaultValue: spec.defaultValue,
    });
  } catch {
    // FLAGS env var missing or Vercel Flags unreachable — fall back to default.
    return spec.defaultValue;
  }
}

const EMPTY_HEADERS = new Headers() as unknown as Parameters<
  ReturnType<typeof vercelAdapter>['decide']
>[0]['headers'];

const EMPTY_COOKIES = {
  get: () => undefined,
} as unknown as Parameters<
  ReturnType<typeof vercelAdapter>['decide']
>[0]['cookies'];
