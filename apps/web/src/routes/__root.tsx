import { TanStackDevtools } from '@tanstack/react-devtools';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { mountVercelToolbar } from '@vercel/toolbar/vite';
import { useEffect, useRef } from 'react';

import AppSplash from '../components/AppSplash';
import DesktopBridge from '../components/DesktopBridge';
import DesktopScrollMask from '../components/DesktopScrollMask';
import DesktopUpdateToast from '../components/DesktopUpdateToast';
import Footer from '../components/Footer';
import Header from '../components/Header';
import { McpTools } from '../components/McpTools';
import NavigationProgress from '../components/NavigationProgress';
import NotFound from '../components/NotFound';
import PageContentTransition from '../components/PageContentTransition';
import RouteError from '../components/RouteError';
import UnionJackCursor from '../components/UnionJackCursor';
import WebHeaderBlur from '../components/WebHeaderBlur';
import { BROWSER_INIT_SCRIPT } from '../scripts/browser-init';
import { DESKTOP_INIT_SCRIPT } from '../scripts/desktop-init';
import { INSTALL_PROMPT_INIT_SCRIPT } from '../scripts/install-prompt-init';
import { SEARCH_INIT_SCRIPT } from '../scripts/search-input-init';
import { STANDALONE_INIT_SCRIPT } from '../scripts/standalone-init';
import { THEME_INIT_SCRIPT } from '../scripts/theme-init';
import { APP_NAME, APP_SHORT_NAME } from '../utils/app-meta';
import { isDesktopPreview } from '../utils/desktop-preview';

import appCss from '../styles.css?url';

/** Drops analytics/vitals events fired inside the /download live-preview iframes so demo runs don't pollute stats. */
const dropPreviewEvents = <E,>(event: E): E | null =>
  isDesktopPreview() ? null : event;
const APP_DESCRIPTION =
  'Search UK skilled worker visa sponsors. Find companies licensed to sponsor skilled worker visas with ratings, locations, and visa routes.';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    errorComponent: RouteError,
    notFoundComponent: NotFound,
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
          // High-priority, parallel-with-CSS so the wordmark (and all body text)
          // paints in Geist at first paint instead of a fallback-then-swap. The
          // SW caches it for instant repeat launches. Stable, unhashed path.
          rel: 'preload',
          href: '/fonts/geist-latin.woff2',
          as: 'font',
          type: 'font/woff2',
          crossOrigin: 'anonymous',
        },
        {
          rel: 'icon',
          type: 'image/svg+xml',
          href: '/favicon.svg',
        },
        {
          rel: 'manifest',
          href: '/manifest.json',
          // Send credentials so the manifest fetch carries Vercel's
          // deployment-protection cookie on preview (else it 307s to SSO → CORS).
          crossOrigin: 'use-credentials',
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
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#ffffff" />
        {/* oxlint-disable-next-line react/no-danger -- static theme init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Desktop init MUST precede search init: in preview iframes it shadows
            sessionStorage, which search-input-init reads. */}
        {/* oxlint-disable-next-line react/no-danger -- static desktop-mode detection, no user input */}
        <script dangerouslySetInnerHTML={{ __html: DESKTOP_INIT_SCRIPT }} />
        {/* oxlint-disable-next-line react/no-danger -- static search input init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: SEARCH_INIT_SCRIPT }} />
        {/* oxlint-disable-next-line react/no-danger -- static browser detection script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: BROWSER_INIT_SCRIPT }} />
        {/* oxlint-disable-next-line react/no-danger -- static standalone-PWA detection, no user input */}
        <script dangerouslySetInnerHTML={{ __html: STANDALONE_INIT_SCRIPT }} />
        {/* oxlint-disable-next-line react/no-danger -- static install-prompt capture, no user input */}
        <script
          dangerouslySetInnerHTML={{ __html: INSTALL_PROMPT_INIT_SCRIPT }}
        />
        <HeadContent />
      </head>
      <body className="flex flex-col font-sans wrap-anywhere antialiased">
        <QueryClientProvider client={queryClient}>
          <McpTools />
          <NavigationProgress />
          <Header />
          <DesktopBridge />
          <DesktopScrollMask />
          <WebHeaderBlur />
          <DesktopUpdateToast />
          <PageContentTransition contentRef={contentRef} />
          {/* flex-1 wrapper makes the footer a sticky footer: on pages shorter
              than the viewport the content grows to fill, pinning the footer to
              the bottom edge so its translucent panel never leaves a strip of
              body glow beneath it. Relies on body's min-height:100% (not vh). */}
          <div ref={contentRef} className="flex flex-1 flex-col">
            {children}
          </div>
          <Footer />
        </QueryClientProvider>
        <UnionJackCursor />
        {/* Rendered after the cursor so it wins the shared max z-index tie. */}
        <AppSplash />
        {/* Must stay an unconditional top-level element: the devtools-vite prod
            strip can't parse it wrapped in `cond && (...)` (build SyntaxError). */}
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
            <Analytics beforeSend={dropPreviewEvents} />
            <SpeedInsights beforeSend={dropPreviewEvents} />
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
    // The /download preview iframes are decorative — no toolbar inside the mini window.
    if (isDesktopPreview()) return;
    mountVercelToolbar();
  }, []);
  return null;
}
