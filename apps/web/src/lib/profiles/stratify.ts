/**
 * Quota allocation for stratified sampling. Extracted from the pilot sampler
 * after the inline version produced two corrected defects (negative quotas
 * when strata outnumber the size; order-dependent draws), so the edge cases
 * are pinned by tests rather than rediscovered.
 */

/**
 * Proportional stratum quotas with a floor of one per non-empty cell, then
 * trimmed (or topped up) to exactly `size` by adjusting the largest cells.
 * Shaving never goes below zero: with more strata than `size`, the floor
 * gives way — a negative quota would keep more than asked, not fewer.
 */
export function allocateQuotas(
  cellSizes: Map<string, number>,
  size: number,
): Map<string, number> {
  const total = [...cellSizes.values()].reduce((sum, n) => sum + n, 0);
  const quotas = new Map<string, number>();
  if (total === 0) return quotas;
  for (const [stratum, n] of cellSizes) {
    // The floor belongs to non-empty cells only, per the contract above.
    quotas.set(
      stratum,
      n === 0 ? 0 : Math.max(1, Math.round((size * n) / total)),
    );
  }
  let allocated = [...quotas.values()].reduce((sum, n) => sum + n, 0);
  while (allocated !== size) {
    const direction = allocated > size ? -1 : 1;
    const ranked = [...quotas.entries()].sort((a, b) => b[1] - a[1]);
    const target = direction === -1 ? ranked.find(([, n]) => n > 0) : ranked[0];
    if (!target) break;
    quotas.set(target[0], (quotas.get(target[0]) as number) + direction);
    allocated += direction;
  }
  return quotas;
}
