import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/counter")({
  loader: () => {
    const hour = new Date().getHours() % 12 || 12;
    return { hour };
  },
  component: Counter,
});

function Counter() {
  const { hour } = Route.useLoaderData();
  const [count, setCount] = useState(hour);

  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">Counter</p>
        <h2 className="display-title mb-3 text-3xl font-bold text-(--sea-ink) sm:text-4xl">
          Server hour: {hour}
        </h2>
        <p className="m-0 mb-6 max-w-3xl text-base leading-8 text-(--sea-ink-soft)">
          The counter starts at the current server hour ({hour}) and can be
          adjusted with the buttons below.
        </p>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setCount((c) => c - 1)}
            className="rounded-xl border border-(--line) bg-(--chip-bg) px-4 py-2 text-lg font-semibold text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
          >
            −
          </button>
          <span className="min-w-[3ch] text-center text-3xl font-bold text-(--sea-ink)">
            {count}
          </span>
          <button
            type="button"
            onClick={() => setCount((c) => c + 1)}
            className="rounded-xl border border-(--line) bg-(--chip-bg) px-4 py-2 text-lg font-semibold text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
          >
            +
          </button>
        </div>
      </section>
    </main>
  );
}
