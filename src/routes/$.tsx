import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/$')({
  beforeLoad: ({ location }) => {
    const params = new URLSearchParams(location.search);
    throw redirect({
      to: '/',
      search: { search: params.get('search') ?? '' },
    });
  },
});
