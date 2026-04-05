import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: App });

function App() {
  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="rise-in py-24 text-center">
        <h1 className="heading-tight mb-4 text-5xl font-semibold text-(--sea-ink) sm:text-6xl">
          Learning
          <br />
          TanStack Start
        </h1>
        <p className="mx-auto mb-8 max-w-xl text-xl leading-relaxed text-(--sea-ink-soft)">
          A hands-on playground for exploring SSR, server functions, database
          integration, and deployment — built from scratch, one concept at a
          time.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            to="/hmrc"
            search={{ search: '' }}
            className="inline-block rounded-md bg-(--sea-ink) px-5 py-2.5 text-sm font-medium text-(--surface) no-underline transition hover:opacity-85"
          >
            HMRC Search
          </Link>
          <a
            href="/data"
            className="shadow-ring inline-block rounded-md px-5 py-2.5 text-sm font-medium text-(--sea-ink) no-underline transition hover:opacity-85"
          >
            View Database Demo
          </a>
          <a
            href="/counter"
            className="shadow-ring inline-block rounded-md px-5 py-2.5 text-sm font-medium text-(--sea-ink) no-underline transition hover:opacity-85"
          >
            Try the Counter
          </a>
        </div>
      </section>

      <hr className="border-t border-(--line)" />

      <section className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [
            'URL State',
            'Counter value lives in the URL — navigate, share, and bookmark state directly.',
          ],
          [
            'Server Functions',
            'Fetch data from Postgres via Drizzle ORM inside createServerFn.',
          ],
          [
            'SSR + Hydration',
            'beforeLoad runs server-side on page load, client-side on SPA navigation.',
          ],
          [
            'Vercel + Neon',
            'Deployed on Vercel with Nitro, backed by a serverless Neon Postgres database.',
          ],
        ].map(([title, desc], index) => (
          <article
            key={title}
            className="glass rise-in rounded-lg p-6"
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <h2 className="heading-card mb-2 text-lg font-semibold text-(--sea-ink)">
              {title}
            </h2>
            <p className="m-0 text-sm leading-relaxed text-(--sea-ink-soft)">
              {desc}
            </p>
          </article>
        ))}
      </section>

      <section className="glass mt-10 rounded-lg p-6">
        <p className="island-kicker mb-3">What I've explored so far</p>
        <ul className="m-0 list-disc space-y-2 pl-5 text-sm text-(--sea-ink-soft)">
          <li>
            File-based routing with dynamic params (<code>/counter/$count</code>
            ) and the <code>_</code> suffix to opt out of layout nesting.
          </li>
          <li>
            <code>beforeLoad</code> behaviour: runs server-side on full page
            load, client-side on SPA navigation.
          </li>
          <li>
            Drizzle ORM with Neon Postgres — schema migrations, data seeding,
            and a custom migration script.
          </li>
          <li>
            Deploying to Vercel via the Nitro plugin, with environment variables
            and serverless function logs.
          </li>
        </ul>
      </section>
    </main>
  );
}
