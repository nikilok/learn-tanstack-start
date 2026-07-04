import {
  ArrowLeft,
  ArrowRight,
  Monitor,
  Moon,
  MousePointer2,
  Share2,
  Sun,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { DesktopPlatform } from '../api/releases';
import Logo from './Logo';

import styles from './Preview.module.css';

/** macOS traffic lights, drawn where the shell insets the native ones (trafficLightPosition x:34, y:16). */
function TrafficLights() {
  return (
    <div className="absolute top-4 left-[34px] z-10 flex gap-2">
      <span className="size-3 rounded-full bg-[#ff5f57] ring-1 ring-black/10 ring-inset" />
      <span className="size-3 rounded-full bg-[#febc2e] ring-1 ring-black/10 ring-inset" />
      <span className="size-3 rounded-full bg-[#28c840] ring-1 ring-black/10 ring-inset" />
    </div>
  );
}

/** Back/forward pill — mirrors the shell's NavControls; back lights up once the demo navigates. */
function NavPill({ canGoBack }: { canGoBack: boolean }) {
  return (
    <div className="flex h-8 items-center rounded-full border border-(--tb-box-bd) bg-(--tb-box-bg) px-[5px] backdrop-blur-sm">
      <span
        className={`grid h-6 w-[30px] place-items-center text-(--tb-fg) ${canGoBack ? 'opacity-[0.55]' : 'opacity-25'}`}
      >
        <ArrowLeft size={18} />
      </span>
      <span className="mx-[3px] h-4 w-px shrink-0 bg-(--tb-box-bd)" />
      <span className="grid h-6 w-[30px] place-items-center text-(--tb-fg) opacity-25">
        <ArrowRight size={18} />
      </span>
    </div>
  );
}

/** SponsorSearch round mark (Union-Jack lens) — mirrors the shell's BrandMark for the title pill. */
function BrandMark({ className }: { className?: string }) {
  // Unique per instance so a second mark never references a hidden clipPath.
  const clipId = `pv-mark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox="0 0 130 130" aria-hidden="true" className={className}>
      <path
        d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85"
        fill="none"
        stroke="var(--tb-mark)"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M100,35 V20 A10,10 0 0 0 90,10 H85"
        fill="none"
        stroke="var(--tb-mark)"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <rect
        x={95}
        y={100}
        width={14}
        height={30}
        rx={6}
        ry={6}
        fill="var(--tb-mark)"
        transform="rotate(-45 95 100)"
      />
      <rect
        x={98}
        y={80}
        width={7}
        height={30}
        rx={6}
        ry={6}
        fill="var(--tb-mark)"
        transform="rotate(-45 95 100)"
      />
      <circle cx={60} cy={60} r={38} fill="var(--tb-mark)" />
      <clipPath id={clipId}>
        <circle cx={60} cy={60} r={29} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x={18} y={18} width={84} height={84} fill="#012169" />
        <path
          d="M18,18 L102,102 M102,18 L18,102"
          stroke="#fff"
          strokeWidth={12}
        />
        <path
          d="M18,18 L102,102 M102,18 L18,102"
          stroke="var(--tb-mark-red)"
          strokeWidth={4}
        />
        <path d="M60,18 V102 M18,60 H102" stroke="#fff" strokeWidth={20} />
        <path
          d="M60,18 V102 M18,60 H102"
          stroke="var(--tb-mark-red)"
          strokeWidth={12}
        />
      </g>
    </svg>
  );
}

/** Centered pill showing the previewed page's cleaned title — 460px, the shell's computed width at 1280. */
function TitlePill({ title }: { title: string }) {
  return (
    <div className="absolute top-1/2 left-1/2 flex h-8 w-[460px] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2 rounded-full border border-(--tb-box-bd) bg-(--tb-box-bg) px-4 backdrop-blur-sm">
      <BrandMark className="size-4 shrink-0" />
      <span className="min-w-0 truncate text-[13px] font-normal text-(--tb-faint)">
        {title}
      </span>
    </div>
  );
}

/** The site's stored theme mode, read post-hydration (SSR renders the 'auto' icon) and re-read on theme flips. */
function useThemeMode(): string {
  const [mode, setMode] = useState('auto');
  useEffect(() => {
    const read = () => {
      const stored = window.localStorage.getItem('theme');
      setMode(stored === 'light' || stored === 'dark' ? stored : 'auto');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return mode;
}

/** Share / cursor / theme utility icons (static — the preview isn't interactive). */
function UtilityControls() {
  const mode = useThemeMode();
  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  const item =
    'grid size-7 place-items-center rounded-md text-(--tb-fg) opacity-[0.55]';
  return (
    <div className="flex items-center gap-0.5">
      <span className={item}>
        <Share2 size={16} />
      </span>
      <span className={item}>
        <MousePointer2 size={16} />
      </span>
      <span className={item}>
        <ThemeIcon size={16} />
      </span>
    </div>
  );
}

/** Windows/Linux minimise / maximise / close cluster — mirrors the shell's WindowControls. */
function WinControls() {
  const btn =
    'grid h-full w-[44px] place-items-center text-(--tb-fg) opacity-70';
  return (
    <div className="flex h-full items-stretch">
      <span className={btn}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
          <line x1="0" y1="5.5" x2="10" y2="5.5" />
        </svg>
      </span>
      <span className={btn}>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
        >
          <rect x="0.5" y="0.5" width="9" height="9" />
        </svg>
      </span>
      <span className={btn}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
        </svg>
      </span>
    </div>
  );
}

/**
 * Decorative replica of the Electron shell's 46px title bar
 * (apps/desktop/src/renderer — keep visually in sync). Rendered inside the
 * preview window's unscaled 1280px coordinate space, so all dimensions match
 * the real chrome and shrink with the window transform.
 */
export default function PreviewTitleBar({
  platform,
  title,
  canGoBack,
}: {
  platform: DesktopPlatform;
  title: string;
  canGoBack: boolean;
}) {
  const isMac = platform === 'mac';
  return (
    <div
      className={`absolute inset-x-0 top-0 h-[46px] select-none ${styles.chrome}`}
    >
      {isMac && <TrafficLights />}
      <div className="absolute top-1/2 left-2 flex -translate-y-1/2 items-center gap-2">
        <div
          className={`flex h-8 items-center rounded-lg border border-(--tb-box-bd) bg-(--tb-box-bg) backdrop-blur-md ${
            isMac ? 'pr-3.5 pl-[102px]' : 'px-3.5'
          }`}
        >
          <Logo
            className="h-5 w-auto"
            navyColor="var(--tb-mark)"
            redColor="var(--tb-mark-red)"
          />
        </div>
        <NavPill canGoBack={canGoBack} />
      </div>
      <TitlePill title={title} />
      {isMac ? (
        <div className="absolute top-1/2 right-5 -translate-y-1/2">
          <UtilityControls />
        </div>
      ) : (
        <div className="absolute top-0 right-0 flex h-full">
          <div className="flex items-center px-2">
            <UtilityControls />
          </div>
          <WinControls />
        </div>
      )}
    </div>
  );
}
