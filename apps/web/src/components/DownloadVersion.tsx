import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DesktopPlatform, DesktopRelease } from '../api/releases';
import {
  desktopReleasesQueryOptions,
  ownerDesktopReleasesQueryOptions,
  setReleaseVisibility,
} from '../api/releases';
import {
  assetLabel,
  OsIcon,
  PLATFORM_LABEL,
  PLATFORM_ORDER,
  sortAssets,
} from './downloadMeta';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';

/** Down-arrow affordance for a download row. */
function DownloadArrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** One platform's variant list within a version. */
function PlatformColumn({
  platform,
  assets,
}: {
  platform: DesktopPlatform;
  assets: DesktopRelease['assets'][DesktopPlatform];
}) {
  const sorted = sortAssets(assets);
  return (
    <div className="rounded-lg border border-(--line) bg-(--sponsor-card-bg) p-4">
      <div className="mb-1 flex items-center gap-2 font-semibold text-(--sea-ink)">
        <OsIcon platform={platform} className="size-4" />
        {PLATFORM_LABEL[platform]}
      </div>
      {sorted.length === 0 ? (
        <p className="py-2 text-sm text-(--sea-ink-faint)">Not available</p>
      ) : (
        <ul className="flex flex-col">
          {sorted.map((a) => (
            <li key={`${a.arch}-${a.format}-${a.installScope}`}>
              <a
                href={a.url}
                className="flex items-center justify-between gap-2 border-t border-(--line) py-2.5 text-sm text-(--sea-ink-soft) no-underline transition hover:text-(--link-blue)"
              >
                <span>{assetLabel(a)}</span>
                <DownloadArrow className="size-4 shrink-0 opacity-70" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Owner-only publish/unpublish control riding the version summary row. */
function VisibilityButton({ release }: { release: DesktopRelease }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const next = release.visibility === 'private' ? 'public' : 'private';
  const { mutate, isPending } = useMutation({
    mutationFn: () =>
      setReleaseVisibility({
        data: { version: release.version, visibility: next },
      }),
    onSuccess: (result) => {
      // ok:false = expired/revoked owner credential (row untouched) — show it,
      // and skip the refetch so the page doesn't silently melt to anonymous.
      if (!result.ok) {
        setFailed(true);
        return;
      }
      if (result.purgeFailed)
        console.error(
          '[publish] edge purge failed — cached public list may lag for client-side navs',
        );
      setFailed(false);
      // Both lists change shape on a flip — refetch them together.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: desktopReleasesQueryOptions.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: ownerDesktopReleasesQueryOptions.queryKey,
        }),
      ]);
    },
    onError: () => setFailed(true),
  });
  return (
    <button
      type="button"
      disabled={isPending}
      className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs transition disabled:opacity-50 ${
        failed
          ? 'border border-(--logo-red) text-(--logo-red)'
          : next === 'public'
            ? 'bg-(--sea-ink) text-(--bg-base) hover:opacity-90'
            : 'border border-(--line) text-(--sea-ink-soft) hover:text-(--sea-ink)'
      }`}
      onClick={(e) => {
        e.preventDefault(); // keep the summary from toggling the disclosure
        e.stopPropagation();
        mutate();
      }}
    >
      {isPending
        ? 'Saving…'
        : failed
          ? 'Failed — retry'
          : next === 'public'
            ? 'Publish'
            : 'Unpublish'}
    </button>
  );
}

/** A version disclosure — a summary (version + badges) over three platform columns. */
export function DownloadVersion({
  release,
  latest,
  defaultOpen,
  owner,
}: {
  release: DesktopRelease;
  latest: boolean;
  defaultOpen: boolean;
  owner: boolean;
}) {
  return (
    <details open={defaultOpen} className="group border-t border-(--line)">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-4 [&::-webkit-details-marker]:hidden">
        <span className="text-2xl font-medium text-(--sea-ink)">
          {release.version}
        </span>
        {latest ? (
          <span className="rounded-full border border-(--line) px-2 py-0.5 text-xs text-(--sea-ink-soft)">
            Latest
          </span>
        ) : null}
        {release.visibility === 'private' ? (
          <span className="rounded-full border border-dashed border-(--logo-red) px-2 py-0.5 text-xs text-(--logo-red)">
            Private
          </span>
        ) : null}
        {owner ? <VisibilityButton release={release} /> : null}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ml-auto size-5 text-(--sea-ink-soft) transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="grid gap-4 pb-6 sm:grid-cols-3">
        {PLATFORM_ORDER.map((p) => (
          <PlatformColumn key={p} platform={p} assets={release.assets[p]} />
        ))}
      </div>
      {release.notes ? (
        <details className="pb-6">
          <summary className="cursor-pointer text-sm text-(--link-blue)">
            View release notes
          </summary>
          <ReleaseNotesMarkdown source={release.notes} />
        </details>
      ) : null}
    </details>
  );
}
