import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

type Post = {
  id: number;
  title: string;
  author: string;
  published: boolean;
};

const getPosts = createServerFn().handler(async () => {
  console.log("🚀 ~ getPosts running on server");
  const posts: Post[] = [
    { id: 1, title: "Getting started with TanStack Start", author: "Alice", published: true },
    { id: 2, title: "Server functions deep dive", author: "Bob", published: true },
    { id: 3, title: "Deploying to Vercel", author: "Charlie", published: false },
  ];
  return posts;
});

export const Route = createFileRoute("/data")({
  component: DataPage,
});

function DataPage() {
  const [posts, setPosts] = useState<Post[] | null>(null);

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Data</p>
        <h2 className="display-title mb-3 text-3xl font-bold text-(--sea-ink) sm:text-4xl">
          Server Function Demo
        </h2>
        <p className="m-0 mb-6 max-w-3xl text-base leading-8 text-(--sea-ink-soft)">
          Click the button to fetch data from a server function.
        </p>
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
                  by {post.author} · {post.published ? "Published" : "Draft"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
