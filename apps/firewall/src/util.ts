/** Normalise an unknown thrown value to a message string. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
