import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { DateTime } from 'luxon';
import { AdminShell } from '@/components/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { convexApi } from '@/lib/convex-api';
import { formatDateTime } from '@/lib/survey';
import { posthogCapture } from '@/lib/posthog';

export const Route = createFileRoute('/_authenticated/surveys/$surveyId/invites')({
  component: SurveyInvitesPage,
});

type SurveyDetail = {
  surveyId: string;
  title: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  currentVersionId?: string;
  currentVersion: {
    surveyVersionId: string;
    version: number;
  } | null;
};

type InviteRow = {
  inviteId: string;
  status: 'active' | 'revoked' | 'exhausted' | 'expired';
  completionCount: number;
  maxCompletions: number;
  expiresAt?: number;
  createdAt: number;
  surveyVersionId: string;
};

function inviteStatusVariant(status: InviteRow['status']) {
  switch (status) {
    case 'active':
      return 'default';
    case 'revoked':
      return 'destructive';
    case 'exhausted':
      return 'secondary';
    case 'expired':
    default:
      return 'outline';
  }
}

function SurveyInvitesPage() {
  const { surveyId } = Route.useParams();
  const survey = useQuery(convexApi.surveys.getSurveyDetail, { surveyId }) as SurveyDetail | null | undefined;
  const invites = useQuery(convexApi.invites.listInvitesForSurvey, { surveyId }) as InviteRow[] | undefined;
  const createInvite = useMutation(convexApi.invites.createInvite);
  const revokeInvite = useMutation(convexApi.invites.revokeInvite);

  const [daysToExpiry, setDaysToExpiry] = useState('30');
  const [maxCompletions, setMaxCompletions] = useState('1');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sortedInvites = useMemo(() => {
    if (!invites) {
      return [];
    }
    return [...invites].sort((a, b) => b.createdAt - a.createdAt);
  }, [invites]);

  const onCreateInvite = async () => {
    if (creating) {
      setMessage('Invite generation is already in progress.');
      setErrorMessage(null);
      return;
    }
    if (!survey?.currentVersion) {
      setErrorMessage('Publish a survey version before creating invites.');
      setMessage(null);
      return;
    }

    const days = Math.max(1, Number.parseInt(daysToExpiry, 10) || 30);
    const completions = Math.max(1, Number.parseInt(maxCompletions, 10) || 1);

    setCreating(true);
    setErrorMessage(null);
    setMessage(null);
    try {
      const expiresAt = DateTime.now().plus({ days }).toMillis();
      const result = (await createInvite({
        surveyId: survey.surveyId,
        surveyVersionId: survey.currentVersion.surveyVersionId,
        expiresAt,
        maxCompletions: completions,
      })) as { inviteId: string; inviteToken: string };

      setGeneratedToken(result.inviteToken);
      setMessage('Invite generated.');

      posthogCapture('invite_created_from_ui', {
        surveyId: survey.surveyId,
        inviteId: result.inviteId,
        maxCompletions: completions,
      });
    } catch (error) {
      setErrorMessage(extractErrorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const onRevokeInvite = async (invite: InviteRow) => {
    if (invite.status !== 'active') {
      setMessage(`Invite is ${invite.status}; no revoke action was applied.`);
      setErrorMessage(null);
      return;
    }

    setErrorMessage(null);
    setMessage(null);

    try {
      await revokeInvite({ inviteId: invite.inviteId });
      setMessage('Invite revoked.');
      posthogCapture('invite_revoked_from_ui', { surveyId, inviteId: invite.inviteId });
    } catch (error) {
      setErrorMessage(extractErrorMessage(error));
    }
  };

  const inviteLink =
    generatedToken && typeof window !== 'undefined'
      ? `${window.location.origin}/s/${generatedToken}`
      : null;

  return (
    <AdminShell heading="Invite Links" description="Generate and manage invite-only respondent links for this survey.">
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/builder/$surveyId" params={{ surveyId }}>
          <Button variant="outline" size="sm">Builder</Button>
        </Link>
        <Link to="/surveys/$surveyId/analytics" params={{ surveyId }}>
          <Button variant="outline" size="sm">Analytics</Button>
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Create Invite</CardTitle>
            <CardDescription>Invite links are anonymous and single-response by default.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!survey?.currentVersion ? (
              <p className="text-muted-foreground text-xs/relaxed">Publish a survey version before creating invites.</p>
            ) : (
              <>
                <Field>
                  <FieldLabel>Expires in (days)</FieldLabel>
                  <Input value={daysToExpiry} onChange={(event) => setDaysToExpiry(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel>Max completions</FieldLabel>
                  <Input value={maxCompletions} onChange={(event) => setMaxCompletions(event.target.value)} />
                  <FieldDescription>Use 1 for one-time completion links.</FieldDescription>
                </Field>
                <Button onClick={() => void onCreateInvite()}>
                  {creating ? 'Generating...' : 'Generate Invite'}
                </Button>

                {generatedToken ? (
                  <div className="rounded-md border p-2">
                    <p className="text-xs font-medium">Generated Invite Token</p>
                    <p className="text-muted-foreground mt-1 break-all font-mono text-[11px]">{generatedToken}</p>
                    {inviteLink ? <p className="text-muted-foreground mt-1 break-all text-[11px]">{inviteLink}</p> : null}
                    <div className="mt-2 flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (inviteLink) {
                            void navigator.clipboard.writeText(inviteLink);
                          }
                        }}
                      >
                        Copy Link
                      </Button>
                    </div>
                  </div>
                ) : null}
                {message ? <p className="text-xs/relaxed text-emerald-700">{message}</p> : null}
                {errorMessage ? <p className="text-destructive text-xs/relaxed">{errorMessage}</p> : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invite History</CardTitle>
            <CardDescription>Status and usage for all invites tied to this survey.</CardDescription>
          </CardHeader>
          <CardContent>
            {invites === undefined ? (
              <p className="text-muted-foreground text-xs/relaxed">Loading invites...</p>
            ) : sortedInvites.length === 0 ? (
              <p className="text-muted-foreground text-xs/relaxed">No invites created yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedInvites.map((invite) => (
                    <TableRow key={invite.inviteId}>
                      <TableCell>
                        <Badge variant={inviteStatusVariant(invite.status)}>{invite.status}</Badge>
                      </TableCell>
                      <TableCell>{invite.completionCount}/{invite.maxCompletions}</TableCell>
                      <TableCell>{formatDateTime(invite.expiresAt)}</TableCell>
                      <TableCell>{formatDateTime(invite.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void onRevokeInvite(invite)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
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
  return 'Invite action failed. Please retry.';
}
