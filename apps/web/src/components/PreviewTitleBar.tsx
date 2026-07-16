import {
  ArrowLeft,
  ArrowRight,
  Monitor,
  Moon,
  MousePointer2,
  Share2,
  Sun,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DesktopPlatform } from '../api/releases';
import { useIsDark } from '../hooks/useIsDark';
import Logo from './Logo';
import { getInitialMode, type ThemeMode } from './ThemeToggle';

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

/** Centered pill showing the previewed page's cleaned title — 460px, the shell's computed width at 1280. */
function TitlePill({ title }: { title: string }) {
  return (
    <div className="absolute top-1/2 left-1/2 flex h-8 w-[460px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-(--tb-box-bd) bg-(--tb-box-bg) px-4 backdrop-blur-sm">
      <span className="min-w-0 truncate text-[13px] font-medium text-(--tb-fg)">
        {title}
      </span>
    </div>
  );
}

/** The site's stored theme mode, read post-hydration (SSR renders the 'auto' icon) and re-read on theme flips. */
function useThemeMode(): ThemeMode {
  const isDark = useIsDark();
  const [mode, setMode] = useState<ThemeMode>('auto');
  useEffect(() => {
    setMode(getInitialMode());
  }, [isDark]);
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
