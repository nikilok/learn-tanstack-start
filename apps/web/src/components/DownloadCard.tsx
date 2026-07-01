import type { ReactNode } from 'react';

/**
 * A download surface card (Cursor-style): a preview image on top, then a title,
 * description, and a call-to-action. The image is a placeholder icon for now —
 * pass `src` later to drop in a platform-specific screenshot.
 */
export default function DownloadCard({
  icon,
  src,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  src?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-(--line) bg-(--sponsor-card-bg) p-4">
      <div className="aspect-video w-full overflow-hidden rounded-md border border-(--line) bg-(--bg-base)">
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            {icon}
          </div>
        )}
      </div>
      <h2 className="mt-5 px-1 text-xl font-semibold text-(--sea-ink)">
        {title}
      </h2>
      <p className="mt-2 px-1 text-sm leading-relaxed text-(--sea-ink-soft)">
        {description}
      </p>
      <div className="mt-6 px-1 pb-1">{children}</div>
    </div>
  );
}
