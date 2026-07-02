import type { ReactNode } from 'react';

/**
 * A download surface card (Cursor-style): a preview image on top, then a title,
 * description, and a call-to-action. `image` fills the aspect-video preview box —
 * pass a screenshot node (e.g. DesktopPreview) or a centred placeholder icon.
 */
export default function DownloadCard({
  image,
  title,
  description,
  children,
}: {
  image: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-(--line) bg-(--sponsor-card-bg) p-4">
      <div className="aspect-video w-full overflow-hidden rounded-md border border-(--line) bg-(--bg-base)">
        {image}
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
