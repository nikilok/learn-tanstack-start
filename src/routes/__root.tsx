import { TanStackDevtools } from '@tanstack/react-devtools';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtoolsPanel } from '@tanstack/react-query-devtools';
import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import Footer from '../components/Footer';
import Header from '../components/Header';
import NavigationProgress from '../components/NavigationProgress';
import RouteError from '../components/RouteError';
import { THEME_INIT_SCRIPT } from '../scripts/theme-init';
import appCss from '../styles.css?url';

const queryClient = new QueryClient();

export const Route = createRootRoute({
  errorComponent: RouteError,
  notFoundComponent: () => {
    return (
      <div className="page-wrap flex flex-col items-center justify-center py-20 text-center">
        <h1 className="text-4xl font-bold text-(--sea-ink)">404</h1>
        <p className="mt-2 text-(--sea-ink-soft)">This page does not exist.</p>
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
        title: 'Skilled Worker Sponsor Search',
      },
      {
        name: 'description',
        content:
          'Search UK skilled worker visa sponsors. Find companies licensed to sponsor skilled worker visas with ratings, locations, and visa routes.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: 'Skilled Worker Sponsor Search' },
      {
        property: 'og:description',
        content:
          'Search UK skilled worker visa sponsors. Find companies licensed to sponsor skilled worker visas with ratings, locations, and visa routes.',
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
      { property: 'og:site_name', content: 'SponsorSearch' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: 'Skilled Worker Sponsor Search' },
      {
        name: 'twitter:description',
        content:
          'Search UK skilled worker visa sponsors. Find companies licensed to sponsor skilled worker visas with ratings, locations, and visa routes.',
      },
      {
        name: 'twitter:image',
        content: 'https://sponsorsearch.co.uk/og-twitter.png',
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.googleapis.com',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#ffffff" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased wrap-anywhere selection:bg-[rgba(0,114,245,0.16)]">
        <QueryClientProvider client={queryClient}>
          <NavigationProgress />
          <Header />
          {children}
          <Footer />
        </QueryClientProvider>
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
        <Scripts />
      </body>
    </html>
  );
}
