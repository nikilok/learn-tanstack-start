interface TitlePillProps {
  title: string;
}

/** Centered fixed-width page title — bare (no pill); the scroll blur backs it when scrolled. */
export function TitlePill({ title }: TitlePillProps) {
  return (
    <div className="absolute top-1/2 left-1/2 flex h-8 w-(--tb-pill-w) -translate-x-1/2 -translate-y-1/2 items-center justify-center px-4">
      <span className="min-w-0 truncate text-[13px] font-medium text-(--tb-fg)">
        {title}
      </span>
    </div>
  );
}
