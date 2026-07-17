interface TitlePillProps {
  title: string;
  inset: { left: number; right: number } | null;
}

/** Page title centered in the gap between the clusters; truncates only when it can't fit. */
export function TitlePill({ title, inset }: TitlePillProps) {
  if (!inset) return null;
  return (
    <div
      className="absolute top-1/2 flex h-8 -translate-y-1/2 items-center justify-center"
      style={{ left: inset.left, right: inset.right }}
    >
      <span className="min-w-0 truncate text-[13px] font-medium text-(--tb-fg)">
        {title}
      </span>
    </div>
  );
}
