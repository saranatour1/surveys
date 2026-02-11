import { Link } from '@tanstack/react-router';
import { useAuth } from '@workos/authkit-tanstack-react-start/client';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="text-muted-foreground hover:text-foreground data-[status=active]:text-foreground text-xs/relaxed"
      activeProps={{ className: 'text-foreground font-medium' }}
    >
      {label}
    </Link>
  );
}

export function AdminShell({ children, heading, description }: { children: ReactNode; heading: string; description?: string }) {
  const { signOut, user } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-card/60">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-sm font-semibold">
              Survey Console
            </Link>
            <nav className="flex items-center gap-3">
              <NavItem to="/surveys" label="Surveys" />
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground hidden text-xs/relaxed sm:inline">{user?.email ?? 'authenticated user'}</span>
            <Button variant="outline" size="sm" onClick={() => signOut()}>
              Logout
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <div className="mb-5">
          <h1 className="text-xl font-semibold">{heading}</h1>
          {description ? <p className="text-muted-foreground mt-1 text-xs/relaxed">{description}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
