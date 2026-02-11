import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { getAuth, getSignInUrl, getSignUpUrl } from '@workos/authkit-tanstack-react-start';
import { useAuth } from '@workos/authkit-tanstack-react-start/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { posthogCapture } from '@/lib/posthog';

export const Route = createFileRoute('/')({
  component: Home,
  loader: async () => {
    const { user } = await getAuth();
    const signInUrl = await getSignInUrl();
    const signUpUrl = await getSignUpUrl();

    return { user, signInUrl, signUpUrl };
  },
});

function Home() {
  const { user, signInUrl, signUpUrl } = Route.useLoaderData();
  const { signOut } = useAuth();

  useEffect(() => {
    posthogCapture('landing_page_viewed', { path: '/' });
  }, []);

  return (
    <div className="mx-auto min-h-screen w-full max-w-5xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <p className="text-sm font-semibold">Survey Platform</p>
        <div className="flex items-center gap-2">
          {user ? (
            <>
              <span className="text-muted-foreground hidden text-xs/relaxed sm:inline">{user.email}</span>
              <Button variant="outline" size="sm" onClick={() => signOut()}>
                Logout
              </Button>
            </>
          ) : null}
        </div>
      </header>

      <main className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Admin Console</CardTitle>
            <CardDescription>Create surveys, publish versions, issue invite tokens, and monitor funnel metrics.</CardDescription>
          </CardHeader>
          <CardContent>
            {user ? (
              <a href="/surveys" className="inline-flex">
                <Button>Open Survey Console</Button>
              </a>
            ) : (
              <div className="flex gap-2">
                <a href={signInUrl}>
                  <Button>Sign in</Button>
                </a>
                <a href={signUpUrl}>
                  <Button variant="outline">Sign up</Button>
                </a>
              </div>
            )}
          </CardContent>
          <CardFooter className="text-muted-foreground text-xs/relaxed">
            Survey authoring is restricted to authenticated admin users.
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Respondent Access</CardTitle>
            <CardDescription>Invite-only anonymous respondents use secure token links.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-muted-foreground text-xs/relaxed">Invite links follow the pattern:</p>
            <code className="bg-muted block rounded px-2 py-1 text-[11px]">/s/&lt;inviteToken&gt;</code>
            <p className="text-muted-foreground text-xs/relaxed">Sessions are resumable on the same browser until submission.</p>
          </CardContent>
          <CardFooter className="text-muted-foreground text-xs/relaxed">
            PostHog + Convex track starts, idles, abandonments, and completions.
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
