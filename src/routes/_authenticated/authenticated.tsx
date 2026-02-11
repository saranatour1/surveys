import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/authenticated')({
  beforeLoad: () => {
    throw redirect({ to: '/surveys' });
  },
  component: () => null,
});
