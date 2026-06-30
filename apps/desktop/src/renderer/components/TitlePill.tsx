import { BrandMark } from './BrandMark';

interface TitlePillProps {
  title: string;
}

/** Centered fixed-width pill: brand mark + the current page title. */
export function TitlePill({ title }: TitlePillProps) {
  return (
    <div className="absolute top-1/2 left-1/2 flex h-8 w-(--tb-pill-w) -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2 rounded-full border border-(--tb-box-bd) bg-(--tb-box-bg) px-4 backdrop-blur-sm">
      <BrandMark className="size-4 shrink-0" />
      <span className="min-w-0 truncate text-[13px] font-normal text-(--tb-faint)">
        {title}
      </span>
    </div>
  );
}
