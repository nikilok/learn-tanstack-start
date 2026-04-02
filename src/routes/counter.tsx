import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/counter")({
  beforeLoad: () => {
    const hour = new Date().getHours() % 12 || 12;
    throw redirect({ to: "/counter/$count", params: { count: String(hour) } });
  },
});
