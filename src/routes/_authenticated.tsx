import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { getAuth, getSignInUrl } from '@workos/authkit-tanstack-react-start';
import { useAuth } from '@workos/authkit-tanstack-react-start/client';
import { useEffect } from 'react';
import { useMutation } from 'convex/react';
import { convexApi } from '@/lib/convex-api';

export const Route = createFileRoute('/_authenticated')({
  loader: async ({ location }) => {
    const { user } = await getAuth();
    if (!user) {
      const path = location.pathname;
      const href = await getSignInUrl({ data: { returnPathname: path } });
      throw redirect({ href });
    }
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const upsertCurrentUser = useMutation(convexApi.users.upsertCurrentUser);

  useEffect(() => {
    if (loading || !user?.id) {
      return;
    }

    void upsertCurrentUser({}).catch(() => {
      // Downstream screens expose actionable error and retry controls.
    });
  }, [loading, user?.id, upsertCurrentUser]);

  return <Outlet />;
}
