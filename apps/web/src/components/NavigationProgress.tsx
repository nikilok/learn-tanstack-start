import { useRouterState } from '@tanstack/react-router';
import styles from './NavigationProgress.module.css';

/**
 * Thin top-of-viewport progress bar shown during TanStack Router page
 * transitions. Filters out search-param-only updates so debounced query typing
 * doesn't flash the bar; returns `null` when the router is idle.
 */
export default function NavigationProgress() {
  const show = useRouterState({
    select: (s) => {
      if (!s.isLoading) return false;
      // Only show for actual page navigations, not search param changes
      const from = s.resolvedLocation?.pathname;
      const to = s.location.pathname;
      return from !== to;
    },
  });

  if (!show) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-100 h-0.5 md:h-0.75">
      <div
        className={`${styles.bar} h-full bg-(--link-blue) dark:bg-(--logo-red)`}
      />
    </div>
  );
}
