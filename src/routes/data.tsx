import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { db } from "../db";
import { posts } from "../db/schema";

const getPosts = createServerFn().handler(async () => {
  return await db.select().from(posts).orderBy(posts.id);
});

export const Route = createFileRoute("/data")({
  loader: () => getPosts(),
  component: DataPage,
});

function DataPage() {
  const postList = Route.useLoaderData();

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Data</p>
        <h2 className="display-title mb-3 text-3xl font-bold text-(--sea-ink) sm:text-4xl">
          Vercel Postgres Demo
        </h2>
        <p className="m-0 mb-6 max-w-3xl text-base leading-8 text-(--sea-ink-soft)">
          Posts loaded from Vercel Postgres via Drizzle ORM.
        </p>
        <ul className="space-y-3">
          {postList.map((post) => (
            <li
              key={post.id}
              className="rounded-xl border border-(--line) bg-(--chip-bg) p-4"
            >
              <h3 className="text-lg font-semibold text-(--sea-ink)">
                {post.title}
              </h3>
              <p className="text-sm text-(--sea-ink-soft)">
                by {post.author} · {post.published ? "Published" : "Draft"}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
