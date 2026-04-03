import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  component: About,
});

function About() {
  return (
    <main className="page-wrap px-4 py-16">
      <section className="mx-auto max-w-2xl">
        <p className="island-kicker mb-3">About</p>
        <h1 className="heading-snug mb-4 text-4xl font-semibold text-(--sea-ink) sm:text-5xl">
          A small starter with room to grow.
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-(--sea-ink-soft)">
          TanStack Start gives you type-safe routing, server functions, and
          modern SSR defaults. Use this as a clean foundation, then layer in
          your own routes, styling, and add-ons.
        </p>
      </section>
    </main>
  );
}
