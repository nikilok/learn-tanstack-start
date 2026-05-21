import { get } from '@vercel/edge-config';
import { decryptOverrides } from 'flags';

/** Minimal flag spec — kept framework-agnostic so the same declaration is consumed by the discovery endpoint metadata and the server-side evaluator. */
export type FlagSpec<T> = {
  key: string;
  description: string;
  defaultValue: T;
  options: { value: T; label: string }[];
  decide: () => T | Promise<T>;
};

/** GOV.UK branded logo on outbound Companies House links. Off by default pending Cabinet Office permission. Source of truth is the `govuk-branded` key in our Vercel Edge Config (dashboard-managed); per-user overrides come from the Flags Explorer cookie. */
export const govukBranded: FlagSpec<boolean> = {
  key: 'govuk-branded',
  description:
    'Show the official GOV.UK SVG logo on the outbound Companies House link',
  defaultValue: false,
  options: [
    { value: false, label: 'Off — plain "gov.uk" text' },
    { value: true, label: 'On — branded GOV.UK logo' },
  ],
  decide: async () => {
    try {
      return (await get<boolean>('govuk-branded')) ?? false;
    } catch {
      // EDGE_CONFIG unset (e.g. before local setup) — fall back to default off.
      return false;
    }
  },
};

export const flags = { govukBranded } as const;

/** Resolves a flag server-side: a signed Flags Explorer override cookie value wins; otherwise the spec's decide() runs. Cookie signatures are verified against FLAGS_SECRET so client tampering invalidates the override and we fall through to decide(). */
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
      // Tampered/expired cookie — fall through to decide().
    }
  }
  return spec.decide();
}
