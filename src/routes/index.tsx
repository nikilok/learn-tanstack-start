import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { getPlatform } from '../api/platform';
import HmrcResults from '../components/HmrcResults';
import SearchBar from '../components/SearchBar';
import { useSearchShortcut } from '../hooks/useSearchShortcut';

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    search: (search.search as string) || '',
  }),
  beforeLoad: async () => {
    const platformInfo = await getPlatform();
    return { platformInfo };
  },
  component: Home,
});

function Home() {
  const { search } = Route.useSearch();
  const { platformInfo } = Route.useRouteContext();
  const navigate = useNavigate();
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isStuck, setIsStuck] = useState(false);
  const [pillClicked, setPillClicked] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsStuck(!entry.isIntersecting);
        if (entry.isIntersecting) setPillClicked(false);
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useSearchShortcut(inputRef, () => setPillClicked(true));

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">
          Search UK skilled worker visa sponsors
        </p>
        <div ref={sentinelRef} className="mt-6" />
        <div className="sticky top-24 z-40 -mx-4 px-4 pb-4">
          <SearchBar
            search={search}
            isStuck={isStuck}
            pillClicked={pillClicked}
            inputRef={inputRef}
            platform={platformInfo.platform}
            isMobile={platformInfo.isMobile}
            onSearch={(value) => {
              if (navTimerRef.current) clearTimeout(navTimerRef.current);
              navTimerRef.current = setTimeout(() => {
                navigate({
                  to: '/',
                  search: { search: value },
                  replace: true,
                });
              }, 300);
            }}
            onPillClick={() => setPillClicked(true)}
            onBlur={() => setPillClicked(false)}
          />
        </div>

        <HmrcResults search={search} />
      </section>
    </main>
  );
}
