import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { useEffect, useRef, useState } from 'react';
import HmrcResults from '../components/HmrcResults';
import SearchBar from '../components/SearchBar';
import { parsePlatform } from '../hooks/usePlatform';

const getPlatform = createServerFn().handler(async () => {
  const ua = getRequestHeader('user-agent') ?? '';
  return parsePlatform(ua);
});

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

  return (
    <main className="page-wrap px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">
          HMRC list of sponsorship providing companies in the UK
        </p>
        <div ref={sentinelRef} className="mt-6" />
        <div className="sticky top-24 z-40 -mx-4 px-4 pb-4">
          <SearchBar
            search={search}
            isStuck={isStuck}
            pillClicked={pillClicked}
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
