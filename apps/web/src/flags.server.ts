import { vercelAdapter } from '@flags-sdk/vercel';
import { decryptOverrides } from 'flags';

/** Minimal flag spec — kept framework-agnostic so the same declaration is consumed by the discovery endpoint metadata and the server-side evaluator. */
export type FlagSpec<T> = {
  key: string;
  description: string;
  defaultValue: T;
  options: { value: T; label: string }[];
};

/** GOV.UK branded logo on outbound Companies House links. Off by default pending Cabinet Office permission. Value is read from the Vercel Flags dashboard (per-environment toggle); per-user overrides come from the Flags Explorer cookie. */
export const govukBranded: FlagSpec<boolean> = {
  key: 'govuk-branded',
  description:
    'Show the official GOV.UK SVG logo on the outbound Companies House link',
  defaultValue: false,
  options: [
    { value: false, label: 'Off — plain "gov.uk" text' },
    { value: true, label: 'On — branded GOV.UK logo' },
  ],
};

export const flags = { govukBranded } as const;

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
