import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { db } from '../db';
import { posts } from '../db/schema';

const getPosts = createServerFn().handler(async () => {
  return await db.select().from(posts).orderBy(posts.id);
});

export const Route = createFileRoute('/data')({
  loader: () => getPosts(),
  component: DataPage,
});

function DataPage() {
  const postList = Route.useLoaderData();

  return (
    <main className="page-wrap px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">Data</p>
        <h2 className="heading-snug mb-3 text-3xl font-semibold text-(--sea-ink) sm:text-4xl">
          Vercel Postgres Demo
        </h2>
        <p className="mb-8 text-base leading-relaxed text-(--sea-ink-soft)">
          Posts loaded from Vercel Postgres via Drizzle ORM.
        </p>
        <ul className="space-y-3">
          {postList.map((post) => (
            <li
              key={post.id}
              className="glass flex items-center justify-between rounded-lg p-4"
            >
              <div>
                <h3 className="heading-card text-base font-semibold text-(--sea-ink)">
                  {post.title}
                </h3>
                <p className="text-sm text-(--sea-ink-soft)">
                  by {post.author}
                </p>
              </div>
              <span className="shrink-0 text-xs text-(--kicker)">
                {post.published && post.publishedAt
                  ? new Date(post.publishedAt).toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'long',
                      year: 'numeric',
                    })
                  : post.published
                    ? 'Published'
                    : 'Draft'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
