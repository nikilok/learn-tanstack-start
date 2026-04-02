import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { sql } from '@vercel/postgres';
import { useState } from 'react';

type Post = {
  id: number;
  title: string;
  author: string;
  published: boolean;
};

const seedPosts = createServerFn().handler(async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      published BOOLEAN DEFAULT false
    )
  `;

  const { rowCount } = await sql`SELECT COUNT(*) FROM posts`;
  if (
    rowCount === 0 ||
    Number((await sql`SELECT COUNT(*) FROM posts`).rows[0].count) === 0
  ) {
    await sql`
      INSERT INTO posts (title, author, published) VALUES
        ('Getting started with TanStack Start', 'Alice', true),
        ('Server functions deep dive', 'Bob', true),
        ('Deploying to Vercel', 'Charlie', false)
    `;
  }

  return { success: true };
});

const getPosts = createServerFn().handler(async () => {
  const { rows } = await sql<Post>`SELECT * FROM posts ORDER BY id`;
  return rows;
});

export const Route = createFileRoute('/data')({
  component: DataPage,
});

function DataPage() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [seeded, setSeeded] = useState(false);

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Data</p>
        <h2 className="display-title mb-3 text-3xl font-bold text-(--sea-ink) sm:text-4xl">
          Vercel Postgres Demo
        </h2>
        <p className="m-0 mb-6 max-w-3xl text-base leading-8 text-(--sea-ink-soft)">
          Seed the database, then fetch posts from Vercel Postgres via a server
          function.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={async () => {
              await seedPosts();
              setSeeded(true);
            }}
            className="rounded-xl border border-(--line) bg-(--chip-bg) px-4 py-2 text-lg font-semibold text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
          >
            {seeded ? 'Seeded' : 'Seed DB'}
          </button>
          <button
            type="button"
            onClick={async () => {
              const data = await getPosts();
              setPosts(data);
            }}
            className="rounded-xl border border-(--line) bg-(--chip-bg) px-4 py-2 text-lg font-semibold text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
          >
            Fetch Data
          </button>
        </div>
        {posts && (
          <ul className="mt-6 space-y-3">
            {posts.map((post) => (
              <li
                key={post.id}
                className="rounded-xl border border-(--line) bg-(--chip-bg) p-4"
              >
                <h3 className="text-lg font-semibold text-(--sea-ink)">
                  {post.title}
                </h3>
                <p className="text-sm text-(--sea-ink-soft)">
                  by {post.author} · {post.published ? 'Published' : 'Draft'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
