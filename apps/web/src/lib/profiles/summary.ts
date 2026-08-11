/**
 * Markdown run summary for the GitHub Actions summary page. Rendering is
 * pure; the harness appends it to $GITHUB_STEP_SUMMARY when present, so a
 * sweep's outcome reads at a glance without opening logs.
 */
/** Insufficient-content rows across every question counter, THE one rate
 *  definition — the console summary and the Actions page must never drift. */
export function insufficientCount(totals: Record<string, number>): number {
  return Object.entries(totals)
    .filter(([key]) => key.endsWith(':insufficient_content'))
    .reduce((sum, [, count]) => sum + count, 0);
}

export function renderRunSummary(
  title: string,
  totals: Record<string, number>,
  seconds: number,
): string {
  const origins = totals.origins ?? 0;
  const answers = totals.answers ?? 0;
  const insufficient = insufficientCount(totals);
  const headline: string[] = [];
  if (origins > 0) {
    headline.push(
      `**${origins}** origins at **${(seconds / origins).toFixed(1)}s/origin**`,
    );
  }
  if (answers > 0) {
    headline.push(
      `**${answers}** answers, **${((insufficient / answers) * 100).toFixed(1)}%** insufficient`,
    );
  }
  const lines = [`### ${title}`, ''];
  if (headline.length > 0) lines.push(headline.join(' · '), '');
  lines.push('| Metric | Count |', '| --- | ---: |');
  for (const key of Object.keys(totals).sort()) {
    lines.push(`| ${key} | ${totals[key]} |`);
  }
  return `${lines.join('\n')}\n`;
}
