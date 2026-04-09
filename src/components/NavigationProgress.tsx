import { useRouterState } from '@tanstack/react-router';
import styles from './NavigationProgress.module.css';

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
    <div className="fixed top-0 left-0 right-0 z-[100] h-0.5">
      <div className={`${styles.bar} h-full bg-[#0072f5]`} />
    </div>
  );
}
