// JSON codec for the two recorded values that are not plain JSON: the rule-name lookup and the live
// WAF config, which carry Maps and Sets.
//
// Every decode is tolerant. A cassette is a file on disk that a crash can truncate and a human can
// edit, and a mock session that refuses to boot over a malformed line is worth less than one that
// boots with that entry missing.

import { asChoice } from '../actions';
import type { LiveConfig } from '../seed-items';

export type EncodedLiveConfig = {
  idByName: [string, string][];
  activeByName: [string, boolean][];
  actionByName: [string, string][];
  headerKeysByName: [string, string[][]][];
};

/** Flatten the live config's Maps and Sets into arrays JSON can hold. */
export function encodeLiveConfig(config: LiveConfig): EncodedLiveConfig {
  return {
    idByName: [...config.idByName],
    activeByName: [...config.activeByName],
    actionByName: [...config.actionByName],
    headerKeysByName: [...config.headerKeysByName].map(([name, groups]) => [
      name,
      groups.map((g) => [...g]),
    ]),
  };
}

/** Pairs of `[string, T]` from an unknown value, dropping anything that is not one. */
function pairs<T>(raw: unknown, valid: (v: unknown) => v is T): [string, T][] {
  if (!Array.isArray(raw)) return [];
  const out: [string, T][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [k, v] = row as [unknown, unknown];
    if (typeof k === 'string' && valid(v)) out.push([k, v]);
  }
  return out;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** Rebuild the live config from a recorded entry. Anything unrecognised decodes to empty, which reads downstream as "this rule is not live" — the safe direction for a tool that shows what is enforced. */
export function decodeLiveConfig(raw: unknown): LiveConfig {
  const src = (raw ?? {}) as Partial<EncodedLiveConfig>;
  const actionByName = new Map(
    pairs(src.actionByName, isString).flatMap(([name, action]) => {
      const choice = asChoice(action);
      return choice ? ([[name, choice]] as const) : [];
    }),
  );
  const headerKeysByName = new Map(
    pairs(
      src.headerKeysByName,
      (v): v is string[][] =>
        Array.isArray(v) && v.every((g) => Array.isArray(g)),
    ).map(([name, groups]) => [
      name,
      groups.map((g) => new Set(g.filter(isString))),
    ]),
  );
  return {
    idByName: new Map(pairs(src.idByName, isString)),
    activeByName: new Map(pairs(src.activeByName, isBoolean)),
    actionByName,
    headerKeysByName,
  };
}

/** Flatten the rule-id to rule-name lookup. */
export function encodeRuleNames(
  names: Map<string, string>,
): [string, string][] {
  return [...names];
}

/** Rebuild the rule-id to rule-name lookup. An unrecognised entry decodes to an empty map, which is exactly what the live lookup returns on failure. */
export function decodeRuleNames(raw: unknown): Map<string, string> {
  return new Map(pairs(raw, isString));
}
