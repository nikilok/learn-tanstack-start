import { createFileRoute, useNavigate } from '@tanstack/react-router';

export const Route = createFileRoute('/counter_/$count')({
  component: Counter,
});

function Counter() {
  const { count } = Route.useParams();
  const navigate = useNavigate();
  const numCount = Number(count);

  return (
    <main className="page-wrap px-4 py-16">
      <section className="mx-auto max-w-md text-center">
        <p className="island-kicker mb-3">Counter</p>
        <h2 className="heading-snug mb-3 text-3xl font-semibold text-(--sea-ink) sm:text-4xl">
          Count: {numCount}
        </h2>
        <p className="mb-8 text-base leading-relaxed text-(--sea-ink-soft)">
          The counter value is persisted in the URL and can be adjusted with the
          buttons below.
        </p>
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() =>
              navigate({
                to: '/counter/$count',
                params: { count: String(numCount - 1) },
              })
            }
            className="glass rounded-md px-4 py-2 text-lg font-medium text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
          >
            −
          </button>
          <span className="min-w-[3ch] text-center text-4xl font-semibold text-(--sea-ink)">
            {numCount}
          </span>
          <button
            type="button"
            onClick={() =>
              navigate({
                to: '/counter/$count',
                params: { count: String(numCount + 1) },
              })
            }
            className="glass rounded-md px-4 py-2 text-lg font-medium text-(--sea-ink) transition hover:bg-(--link-bg-hover)"
          >
            +
          </button>
        </div>
      </section>
    </main>
  );
}
