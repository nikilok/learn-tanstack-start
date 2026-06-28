import { TanStackDevtools } from '@tanstack/react-devtools';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Link,
  Scripts,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { mountVercelToolbar } from '@vercel/toolbar/vite';
import { useEffect } from 'react';

import Footer from '../components/Footer';
import Header from '../components/Header';
import { McpTools } from '../components/McpTools';
import NavigationProgress from '../components/NavigationProgress';
import RouteError from '../components/RouteError';
import UnionJackCursor from '../components/UnionJackCursor';
import { BROWSER_INIT_SCRIPT } from '../scripts/browser-init';
import { SEARCH_INIT_SCRIPT } from '../scripts/search-input-init';
import { THEME_INIT_SCRIPT } from '../scripts/theme-init';

import appCss from '../styles.css?url';

const APP_NAME = 'Skilled Worker Sponsor Search';
const APP_SHORT_NAME = 'SponsorSearch';
const APP_DESCRIPTION =
  'Search UK skilled worker visa sponsors. Find companies licensed to sponsor skilled worker visas with ratings, locations, and visa routes.';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    errorComponent: RouteError,
    notFoundComponent: () => {
      return (
        <div className="page-wrap flex flex-col items-center justify-center py-20 text-center">
          <h1 className="text-4xl font-bold text-(--sea-ink)">404</h1>
          <p className="mt-2 text-(--sea-ink-soft)">
            This page does not exist.
          </p>
          <Link
            to="/"
            search={{ search: '' }}
            className="mt-4 text-(--link-blue) underline"
          >
            Go to home
          </Link>
        </div>
      );
    },
    head: () => ({
      meta: [
        {
          charSet: 'utf-8',
        },
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1, viewport-fit=cover',
        },
        {
          title: APP_NAME,
        },
        {
          name: 'description',
          content: APP_DESCRIPTION,
        },
        { property: 'og:type', content: 'website' },
        { property: 'og:title', content: APP_NAME },
        {
          property: 'og:description',
          content: APP_DESCRIPTION,
        },
        { property: 'og:image', content: 'https://sponsorsearch.co.uk/og.png' },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        {
          property: 'og:image',
          content: 'https://sponsorsearch.co.uk/og-square.png',
        },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '1200' },
        { property: 'og:url', content: 'https://sponsorsearch.co.uk' },
        { property: 'og:site_name', content: APP_SHORT_NAME },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: APP_NAME },
        {
          name: 'twitter:description',
          content: APP_DESCRIPTION,
        },
        {
          name: 'twitter:image',
          content: 'https://sponsorsearch.co.uk/og-twitter.png',
        },
        { name: 'twitter:url', content: 'https://sponsorsearch.co.uk' },
        // PWA / installability — iOS only honours the apple-prefixed capable + title meta.
        { name: 'application-name', content: APP_SHORT_NAME },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-title', content: APP_SHORT_NAME },
        {
          name: 'apple-mobile-web-app-status-bar-style',
          content: 'default',
        },
      ],
      links: [
        {
          rel: 'icon',
          type: 'image/svg+xml',
          href: '/favicon.svg',
        },
        {
          rel: 'manifest',
          href: '/manifest.json',
        },
        {
          rel: 'apple-touch-icon',
          href: '/apple-touch-icon.png',
        },
        {
          rel: 'stylesheet',
          href: appCss,
        },
      ],
    }),
    shellComponent: RootDocument,
  },
);

/**
 * Root HTML shell for every route. Inlines the theme and search-input-init
 * scripts in `<head>` to prevent first-paint flashes, wraps children in the
 * shared QueryClientProvider, and mounts global chrome (Header, Footer,
 * NavigationProgress, McpTools) plus devtools and Vercel analytics in prod.
 */
function RootDocument({ children }: { children: React.ReactNode }) {
  const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#ffffff" />
        {/* oxlint-disable-next-line react/no-danger -- static theme init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* oxlint-disable-next-line react/no-danger -- static search input init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: SEARCH_INIT_SCRIPT }} />
        {/* oxlint-disable-next-line react/no-danger -- static browser detection script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: BROWSER_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="flex flex-col font-sans wrap-anywhere antialiased">
        <QueryClientProvider client={queryClient}>
          <McpTools />
          <NavigationProgress />
          <Header />
          {/* flex-1 wrapper makes the footer a sticky footer: on pages shorter
              than the viewport the content grows to fill, pinning the footer to
              the bottom edge so its translucent panel never leaves a strip of
              body glow beneath it. Relies on body's min-height:100% (not vh). */}
          <div className="flex flex-1 flex-col">{children}</div>
          <Footer />
        </QueryClientProvider>
        <UnionJackCursor />
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            {
              name: 'Tanstack Query',
              render: <ReactQueryDevtoolsPanel client={queryClient} />,
            },
          ]}
        />
        {import.meta.env.PROD && (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        )}
        {import.meta.env.DEV && (
          <ClientOnly>
            <VercelToolbarMount />
          </ClientOnly>
        )}
        <Scripts />
      </body>
    </html>
  );
}

/** Mounts the Vercel Toolbar in local dev so the Flags Explorer is available here. Preview deploys get the toolbar auto-injected by Vercel; production stays unmounted. */
function VercelToolbarMount() {
  useEffect(() => {
    mountVercelToolbar();
  }, []);
  return null;
}
