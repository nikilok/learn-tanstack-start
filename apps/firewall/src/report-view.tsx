// The report pane's composition root — what appears, in what order, and the not-yet-loaded
// states. Each section's rendering lives in its own module (count-list, distribution-block),
// and the formatting they share in report-format.

import { Box, Text } from 'ink';

import { CountList } from './count-list';
import { DistributionBlock } from './distribution-block';
import type { ReportData } from './report-data';

/** Trim an ISO timestamp to `YYYY-MM-DD HH:MM` for the window header. */
const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** Before any data exists the pane is either a hard failure or still loading; both need their own key hints, since 'r' means retry in one and nothing in the other. */
function ReportPlaceholder({ error }: { error: string }) {
  return error ? (
    <Box flexDirection="column">
      <Text color="red" wrap="truncate">
        Report failed: {error}
      </Text>
      <Text dimColor>esc rules · r retry · q quit</Text>
    </Box>
  ) : (
    <Box flexDirection="column">
      <Text>Loading report…</Text>
      <Text dimColor>esc → rules (keeps loading) · q quit</Text>
    </Box>
  );
}

/** In-app firewall report view — the rule-tuning data (actions-by-rule, top paths, per-IP peaks), opened with 'r' from the rule list and shown in the side pane. Compact by design. */
export function ReportView({
  report,
  error,
  loading,
}: {
  report: ReportData | null;
  error: string;
  loading: boolean;
}) {
  if (!report) return <ReportPlaceholder error={error} />;
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate">
        report — {fmt(report.start)} → {fmt(report.now)}
        {loading ? ' · refreshing…' : ''}
      </Text>
      {/* A refresh failure keeps the previous report on screen — stale data beats none. */}
      {error && (
        <Text color="red" wrap="truncate">
          refresh failed — {error}
        </Text>
      )}

      <CountList
        title="actions by rule (rl-* = a limit fired)"
        rows={report.byRule}
        error={report.byRuleError}
        empty="(no firewall actions)"
      />
      <CountList
        title="top request paths"
        rows={report.topPaths.map((p) => ({ label: p.path, count: p.count }))}
        error={report.topPathsError}
      />

      {report.distributions.map((d) => (
        <DistributionBlock key={d.label} dist={d} />
      ))}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>↑/↓ scroll · esc rules · r refresh · q quit</Text>
      </Box>
    </Box>
  );
}
