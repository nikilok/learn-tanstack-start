// Body of whichever side pane is open. Report keeps its bespoke Ink view; the list panes share
// the line model, so each is a `*Lines` call plus the cursor.

import { Box, Text } from 'ink';

import type { Advice } from '../ban-advice';
import { denylistLines } from '../denylist-view';
import { DENY_ACTIVITY_HOURS } from '../hooks/useDenylist';
import type { Denylist } from '../hooks/useDenylist';
import type { IdentityLists } from '../hooks/useIdentityLists';
import type { IpTab } from '../hooks/useIpTabs';
import type { Pane } from '../hooks/usePane';
import type { IpProfile } from '../ip-profile';
import { profileLines } from '../ip-profile-view';
import type { PaneKind } from '../pane-keys';
import type { ReportData } from '../report-data';
import type { SitemapReport } from '../sitemap-readers';
import { sitemapLines } from '../sitemap-view';
import { ignoreListLines, watchlistLines } from '../watchlist-view';
import { Lines } from './lines';
import { ReportView } from './report-view';

/**
 * The profile, plus a note if the allowlist could not be read.
 *
 * Non-mutating: the profile is rendered state. An unreadable allowlist exempts EVERY verified
 * crawler, which is a large silent change in what this pane recommends — inferring it from
 * "everything is suddenly legitimate" is not something an operator should have to do.
 */
function withAllowlistError(
  p: IpProfile,
  error: string | undefined,
): IpProfile {
  return error
    ? { ...p, errors: [...p.errors, `FW_ALLOWED_BOTS: ${error}`] }
    : p;
}

/** Body of whichever side pane is open. Report keeps its bespoke Ink view; the other two share the line model. */
export function PaneBody({
  kind,
  width,
  report,
  ipTab,
  sitemap,
  advice,
  sitemapCursor,
  allowlistError,
  denylist,
  lists,
}: {
  kind: PaneKind;
  width: number;
  report: Pane<ReportData>;
  ipTab: IpTab | undefined;
  sitemap: Pane<SitemapReport>;
  advice: Advice | undefined;
  sitemapCursor: number;
  /** The allowlist read the advice was computed from, so the pane's note cannot describe a different one. */
  allowlistError?: string;
  denylist: Denylist;
  lists: IdentityLists;
}) {
  if (kind === 'report')
    return (
      <ReportView
        report={report.data}
        error={report.error}
        loading={report.loading}
      />
    );
  if (kind === 'denylist')
    return (
      <Lines
        lines={denylistLines(
          {
            windowHours: DENY_ACTIVITY_HOURS,
            entries: denylist.entries,
            notEnforcing: denylist.live.notEnforcing,
            error:
              denylist.activity.error || denylist.activityNote || undefined,
          },
          denylist.cursor,
        )}
        width={width}
      />
    );
  if (kind === 'watchlist')
    return (
      <Lines
        lines={watchlistLines(
          {
            entries: lists.watch.entries,
            error: lists.watch.error || undefined,
          },
          lists.watch.cursor,
          Date.now(),
        )}
        width={width}
      />
    );
  if (kind === 'ignorelist')
    return (
      <Lines
        lines={ignoreListLines(
          {
            entries: lists.ignore.entries,
            error: lists.ignore.error || undefined,
          },
          lists.ignore.cursor,
          Date.now(),
        )}
        width={width}
      />
    );
  // Every other kind returned above. Checked HERE rather than only at the render below, which is
  // where the first version of this guard stopped: an unhandled kind still fell through to the
  // sitemap's state and reported ITS loading, error and empty text under its own name.
  if (kind !== 'ip' && kind !== 'sitemap')
    return <Text dimColor>nothing to show for this pane</Text>;
  const what = kind === 'ip' ? 'IP profile' : 'sitemap readers';
  const state = kind === 'ip' ? ipTab : sitemap;
  if (!state) return <Text dimColor>no {what} yet — i to look one up</Text>;
  if (state.error) return <Text color="red">{state.error}</Text>;
  if (!state.data)
    return (
      <Text dimColor>
        {state.loading ? `Loading ${what}…` : `no ${what} yet`}
      </Text>
    );
  // Narrowed on the kind rather than cast, and anything unhandled says so. The casts here made
  // 'ip' and everything-else exhaustive by assertion: a seventh pane kind would have fallen into
  // the sitemap branch and drawn the sitemap's rows under its own name, with the types silent.
  const lines =
    kind === 'ip' && ipTab?.data
      ? profileLines(
          withAllowlistError(ipTab.data, allowlistError),
          width,
          advice,
        )
      : kind === 'sitemap' && sitemap?.data
        ? sitemapLines(sitemap.data, sitemapCursor)
        : null;
  if (!lines) return <Text dimColor>nothing to show for this pane</Text>;
  return (
    <Box flexDirection="column">
      {state.loading && <Text dimColor>refreshing…</Text>}
      <Lines lines={lines} width={width} />
    </Box>
  );
}
