import { useRouterState } from '@tanstack/react-router';
import styles from './NavigationProgress.module.css';

export default function NavigationProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });

  if (!isLoading) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] h-0.5">
      <div className={`${styles.bar} h-full bg-[#0072f5]`} />
    </div>
  );
}
