// Enter in the search box before the box offers to ask: the name search is
// still settling, and the press means "ask this if nothing is found by
// name". Pure; the route keeps the remembered text in a ref.

/** The text to remember from a press while its name search is still to settle (running, or the URL behind the box), or null when there is nothing to wait for: the search has settled, an ask is already running, or the box is empty. */
export function enterIntent(
  typed: string,
  {
    search,
    loading,
    asking,
  }: { search: string; loading: boolean; asking: boolean },
): string | null {
  const text = typed.trim();
  if (!text || asking) return null;
  return loading || search.trim() !== text ? text : null;
}

/** What becomes of a remembered press as the search moves: `ask` once the box offers for that text, `drop` once the box's text moved on or its search settled with no offer, `hold` while the URL lags the box or the search runs. */
export function settleEnterIntent(
  intent: string,
  {
    typed,
    search,
    eligible,
    loading,
  }: { typed: string; search: string; eligible: boolean; loading: boolean },
): 'ask' | 'drop' | 'hold' {
  if (typed.trim() !== intent) return 'drop';
  if (search.trim() !== intent) return 'hold';
  if (eligible) return 'ask';
  return loading ? 'hold' : 'drop';
}
