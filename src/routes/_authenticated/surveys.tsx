import { Link, Outlet, createFileRoute, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useAuth } from '@workos/authkit-tanstack-react-start/client';
import { AdminShell } from '@/components/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { convexApi } from '@/lib/convex-api';
import { posthogCapture, posthogIdentify } from '@/lib/posthog';

export const Route = createFileRoute('/_authenticated/surveys')({
  component: SurveysPage,
});

type SurveyRow = {
  surveyId: string;
  slug: string;
  title: string;
  description?: string;
  status: 'draft' | 'published' | 'archived';
  currentVersionId?: string;
  createdAt: number;
  updatedAt: number;
};

type SeedSurveyRow = {
  surveyId: string;
  slug: string;
  title: string;
  inviteToken: string;
  startedCount: number;
  completedCount: number;
  idleCount: number;
  abandonedCount: number;
  inProgressCount: number;
};

type SeedResult = {
  owner: {
    appUserId: string;
    email: string;
    role: 'admin' | 'member';
  };
  createdSurveyCount: number;
  createdSessionCount: number;
  createdResponseCount: number;
  surveys: SeedSurveyRow[];
  seededAt: number;
};

function statusVariant(status: SurveyRow['status']) {
  switch (status) {
    case 'published':
      return 'default';
    case 'archived':
      return 'outline';
    case 'draft':
    default:
      return 'secondary';
  }
}

function SurveysPage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const normalizedPathname = pathname.replace(/\/+$/, '') || '/';
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedStatus, setSeedStatus] = useState<string | null>(null);
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);

  const bootstrapUser = useMutation(convexApi.users.upsertCurrentUser);
  const currentUser = useQuery(convexApi.users.getCurrentUser, {}) as { role: string; email: string } | null | undefined;
  const createSurvey = useMutation(convexApi.surveys.createSurvey);
  const seedSurveyFixtures = useMutation(convexApi.devSeed.seedMySurveyFixtures);
  const canCreate = !!currentUser && !creating;

  const surveys = useQuery(convexApi.surveys.listSurveys, currentUser ? {} : 'skip') as SurveyRow[] | undefined;

  useEffect(() => {
    if (currentUser !== null || !user?.id) {
      return;
    }

    setBootstrapping(true);
    void bootstrapUser({})
      .catch(() => {
        // Keep null state; UI will explain next action.
      })
      .finally(() => {
        setBootstrapping(false);
      });
  }, [currentUser, bootstrapUser, user?.id]);

  useEffect(() => {
    if (!user?.id || !currentUser) {
      return;
    }

    posthogIdentify(user.id, {
      role: currentUser.role,
      email: currentUser.email,
    });
  }, [user?.id, currentUser?.role, currentUser?.email]);

  useEffect(() => {
    posthogCapture('admin_surveys_page_viewed', {
      path: '/surveys',
    });
  }, []);

  const totalStats = useMemo(() => {
    const rows = surveys ?? [];
    const published = rows.filter((row) => row.status === 'published').length;
    const draft = rows.filter((row) => row.status === 'draft').length;
    return { total: rows.length, published, draft };
  }, [surveys]);

  const onCreateSurvey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError(null);
    if (creating) {
      setCreateError('Survey creation is already in progress.');
      return;
    }
    if (!title.trim() || !slug.trim()) {
      setCreateError('Title and slug are required.');
      return;
    }
    if (!currentUser) {
      setCreateError('Account profile still initializing. Please wait a moment and retry.');
      return;
    }
    setCreating(true);

    try {
      const result = (await createSurvey({
        title: title.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
      })) as { surveyId: string };

      posthogCapture('survey_create_clicked', {
        surveyId: result.surveyId,
      });

      setTitle('');
      setSlug('');
      setDescription('');
    } catch (error) {
      const message = extractErrorMessage(error);
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  };

  const onRetryProfile = async () => {
    setCreateError(null);
    if (bootstrapping) {
      setCreateError('Profile setup is already running.');
      return;
    }
    setBootstrapping(true);
    try {
      await bootstrapUser({});
    } catch (error) {
      setCreateError(extractErrorMessage(error));
    } finally {
      setBootstrapping(false);
    }
  };

  const onSeedFixtures = async () => {
    setSeedError(null);
    setSeedStatus(null);

    if (seeding) {
      setSeedStatus('Seeding is already in progress.');
      return;
    }

    if (!currentUser) {
      setSeedError('Account profile still initializing. Please wait, then retry.');
      return;
    }

    setSeeding(true);
    try {
      const result = (await seedSurveyFixtures({
        surveyCount: 3,
        sessionsPerSurvey: 36,
      })) as SeedResult;

      setSeedResult(result);
      setSeedStatus(
        `Seeded ${result.createdSurveyCount} surveys with ${result.createdSessionCount} sessions and ${result.createdResponseCount} responses.`,
      );

      posthogCapture('survey_seed_data_created', {
        surveyCount: result.createdSurveyCount,
        sessionCount: result.createdSessionCount,
        responseCount: result.createdResponseCount,
      });
    } catch (error) {
      setSeedError(extractErrorMessage(error));
    } finally {
      setSeeding(false);
    }
  };

  if (normalizedPathname !== '/surveys') {
    return <Outlet />;
  }

  return (
    <AdminShell
      heading="Surveys"
      description="Create and manage survey definitions, versions, invites, and analytics for invite-only respondents."
    >
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Total Surveys</CardDescription>
            <CardTitle>{totalStats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Published</CardDescription>
            <CardTitle>{totalStats.published}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Draft</CardDescription>
            <CardTitle>{totalStats.draft}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Create Survey</CardTitle>
            <CardDescription>Authenticated users can create and manage their own surveys.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3 text-xs/relaxed">
              Current role: <span className="font-medium">{currentUser?.role ?? (bootstrapping ? 'initializing...' : 'unknown')}</span>
            </p>
            <form className="space-y-3" onSubmit={onCreateSurvey}>
              <Field>
                <FieldLabel>Title</FieldLabel>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Customer Satisfaction" />
              </Field>
              <Field>
                <FieldLabel>Slug</FieldLabel>
                <Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="customer-satisfaction" />
                <FieldDescription>Used as internal stable identifier. Lowercase and dashes recommended.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Description</FieldLabel>
                <Textarea
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional survey description"
                />
              </Field>
              {createError ? <p className="text-destructive text-xs/relaxed">{createError}</p> : null}
              {seedError ? <p className="text-destructive text-xs/relaxed">{seedError}</p> : null}
              {seedStatus ? <p className="text-emerald-700 text-xs/relaxed">{seedStatus}</p> : null}
              <p className="text-muted-foreground text-xs/relaxed">
                Profile status: {bootstrapping ? 'initializing...' : currentUser ? 'ready' : 'missing'}
              </p>
              {!currentUser ? (
                <Button type="button" variant="outline" onClick={() => void onRetryProfile()}>
                  {bootstrapping ? 'Initializing...' : 'Retry Profile Setup'}
                </Button>
              ) : null}
              <Button type='submit'>
                {creating ? 'Creating...' : 'Create Survey'}
              </Button>
              <Button type="button" variant="outline" onClick={() => void onSeedFixtures()}>
                {seeding ? 'Seeding...' : 'Seed Test Data (3 Surveys)'}
              </Button>
            </form>
            {seedResult ? (
              <div className="mt-3 space-y-2 rounded-md border p-2">
                <p className="text-xs font-medium">Latest Seed Run</p>
                {seedResult.surveys.map((row) => (
                  <div key={row.surveyId} className="space-y-1 text-xs">
                    <p className="font-medium">{row.title}</p>
                    <p className="text-muted-foreground">
                      started={row.startedCount} completed={row.completedCount} idle={row.idleCount} abandoned={row.abandonedCount}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Link to="/builder/$surveyId" params={{ surveyId: row.surveyId }}>
                        <Button variant="outline" size="sm">Builder</Button>
                      </Link>
                      <Link to="/surveys/$surveyId/analytics" params={{ surveyId: row.surveyId }}>
                        <Button variant="outline" size="sm">Analytics</Button>
                      </Link>
                      <a className="text-xs underline" href={`/s/${row.inviteToken}`} target="_blank" rel="noreferrer">
                        Open Invite Link
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>All Surveys</CardTitle>
            <CardDescription>Open a survey to edit fields, publish versions, manage invites, and view analytics.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {surveys === undefined ? (
              <p className="text-muted-foreground text-xs/relaxed">Loading surveys...</p>
            ) : surveys.length === 0 ? (
              <p className="text-muted-foreground text-xs/relaxed">No surveys yet. Create one to begin.</p>
            ) : (
              surveys.map((survey) => (
                <div key={survey.surveyId} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{survey.title}</p>
                    <p className="text-muted-foreground truncate text-xs/relaxed">/{survey.slug}</p>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <Badge variant={statusVariant(survey.status)}>{survey.status}</Badge>
                    <Link to="/builder/$surveyId" params={{ surveyId: survey.surveyId }}>
                      <Button variant="outline" size="sm">
                        Open
                      </Button>
                    </Link>
                  </div>
                </div>
              ))
            )}
          </CardContent>
          <CardFooter className="text-muted-foreground text-xs/relaxed">
            Create draft versions in Builder, then publish before generating invite links.
          </CardFooter>
        </Card>
      </div>
    </AdminShell>
  );
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const nested = error as { data?: { message?: string }; message?: string };
    if (nested.data?.message) {
      return nested.data.message;
    }
    if (nested.message) {
      return nested.message;
    }
  }
  return 'Failed to create survey. Check your account profile initialization and Convex deployment state.';
}
