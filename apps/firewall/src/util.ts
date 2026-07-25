/** Read a firewall ceiling (FW_*_LIMIT) from the env, or undefined when absent/invalid. Single source of what counts as a valid ceiling: the rule builder turns this into a throw or an omitted rule, and the report turns it into a bar to measure against — if those disagreed, the pane would draw a ceiling the rules never enforced. */
export function envCeiling(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Normalise an unknown thrown value to a message string, preserving `message` from non-Error throws (some SDKs reject with a plain `{ message }`). */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string'
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
}
