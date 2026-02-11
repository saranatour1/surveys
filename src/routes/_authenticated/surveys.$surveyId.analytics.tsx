import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import { DateTime } from 'luxon';
import { AdminShell } from '@/components/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { convexApi } from '@/lib/convex-api';
import { formatDateTime, formatRelativeMinutes } from '@/lib/survey';

export const Route = createFileRoute('/_authenticated/surveys/$surveyId/analytics')({
  component: SurveyAnalyticsPage,
});

type Funnel = {
  started: number;
  completed: number;
  idle: number;
  abandoned: number;
  reactivated: number;
  conversionRate: number;
};

type ScoringSummary = {
  gradedResponses: number;
  avgScorePercent: number;
  totalCorrect: number;
  totalIncorrect: number;
};

type AnswerBreakdown = {
  fieldId: string;
  label: string;
  kind:
    | 'short_text'
    | 'long_text'
    | 'single_select'
    | 'multi_select'
    | 'number'
    | 'email'
    | 'date'
    | 'rating_1_5';
  totalAnswered: number;
  buckets: Array<{
    key: string;
    label: string;
    count: number;
    percent: number;
  }>;
};

type IdleSession = {
  sessionId: string;
  sessionPublicId: string;
  status: 'idle' | 'abandoned' | 'in_progress' | 'completed';
  startedAt: number;
  lastActivityAt: number;
  idleMinutes: number;
  inviteId: string;
};

type InviteRow = {
  inviteId: string;
  status: 'active' | 'revoked' | 'exhausted' | 'expired';
  completionCount: number;
  maxCompletions: number;
  expiresAt?: number;
  createdAt: number;
};

function SurveyAnalyticsPage() {
  const { surveyId } = Route.useParams();

  const [fromDate, setFromDate] = useState(DateTime.now().minus({ days: 29 }).toISODate() ?? '');
  const [toDate, setToDate] = useState(DateTime.now().toISODate() ?? '');
  const [selectedFieldId, setSelectedFieldId] = useState<string>('');

  const survey = useQuery(convexApi.surveys.getSurveyDetail, { surveyId }) as
    | { surveyId: string; title: string; slug: string }
    | null
    | undefined;

  const funnel = useQuery(convexApi.analytics.getSurveyFunnel, {
    surveyId,
    fromDate,
    toDate,
  }) as Funnel | undefined;

  const scoring = useQuery(convexApi.analytics.getSurveyScoringSummary, {
    surveyId,
    fromDate,
    toDate,
  }) as ScoringSummary | undefined;

  const answerBreakdown = useQuery(convexApi.analytics.getSurveyAnswerBreakdown, {
    surveyId,
    fromDate,
    toDate,
  }) as AnswerBreakdown[] | undefined;

  const idleSessions = useQuery(convexApi.analytics.listIdleSessions, {
    surveyId,
    page: 0,
    limit: 100,
  }) as IdleSession[] | undefined;

  const invites = useQuery(convexApi.invites.listInvitesForSurvey, {
    surveyId,
  }) as InviteRow[] | undefined;

  const inviteStats = useMemo(() => {
    const rows = invites ?? [];
    const total = rows.length;
    const active = rows.filter((row) => row.status === 'active').length;
    const exhausted = rows.filter((row) => row.status === 'exhausted').length;
    const completions = rows.reduce((sum, row) => sum + row.completionCount, 0);
    return { total, active, exhausted, completions };
  }, [invites]);

  useEffect(() => {
    if (!answerBreakdown || answerBreakdown.length === 0) {
      setSelectedFieldId('');
      return;
    }

    const selectedStillExists = answerBreakdown.some((field) => field.fieldId === selectedFieldId);
    if (!selectedFieldId || !selectedStillExists) {
      setSelectedFieldId(answerBreakdown[0].fieldId);
    }
  }, [answerBreakdown, selectedFieldId]);

  const selectedAnswerField = useMemo(
    () => answerBreakdown?.find((field) => field.fieldId === selectedFieldId) ?? null,
    [answerBreakdown, selectedFieldId],
  );

  return (
    <AdminShell
      heading={`Analytics${survey?.title ? `: ${survey.title}` : ''}`}
      description="Track started, completed, idle, and abandoned respondents with real-time Convex metrics."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/builder/$surveyId" params={{ surveyId }}>
          <Button variant="outline" size="sm">Builder</Button>
        </Link>
        <Link to="/surveys/$surveyId/invites" params={{ surveyId }}>
          <Button variant="outline" size="sm">Invites</Button>
        </Link>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Date Range</CardTitle>
          <CardDescription>Funnel values are rolled up from daily metrics in UTC.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
          <Field>
            <FieldLabel>From</FieldLabel>
            <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>To</FieldLabel>
            <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
          </Field>
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Started" value={funnel?.started} />
        <MetricCard label="Completed" value={funnel?.completed} />
        <MetricCard label="Idle" value={funnel?.idle} />
        <MetricCard label="Abandoned" value={funnel?.abandoned} />
        <MetricCard label="Conversion" value={funnel ? `${funnel.conversionRate.toFixed(2)}%` : undefined} />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Graded Responses" value={scoring?.gradedResponses} />
        <MetricCard label="Avg Score" value={scoring ? `${scoring.avgScorePercent.toFixed(2)}%` : undefined} />
        <MetricCard label="Total Correct" value={scoring?.totalCorrect} />
        <MetricCard label="Total Incorrect" value={scoring?.totalIncorrect} />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Answer Insights</CardTitle>
          <CardDescription>Custom distribution graph of submitted answers by question.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {answerBreakdown === undefined ? (
            <p className="text-muted-foreground text-xs/relaxed">Loading answer insights...</p>
          ) : answerBreakdown.length === 0 ? (
            <p className="text-muted-foreground text-xs/relaxed">No submitted answers in this date range.</p>
          ) : (
            <>
              <Field>
                <FieldLabel>Question</FieldLabel>
                <Select
                  value={selectedFieldId}
                  onValueChange={(value) => {
                    if (value) {
                      setSelectedFieldId(value);
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-[420px]">
                    <SelectValue placeholder="Select a question" />
                  </SelectTrigger>
                  <SelectContent>
                    {answerBreakdown.map((field) => (
                      <SelectItem key={field.fieldId} value={field.fieldId}>
                        {field.label} ({field.kind})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {selectedAnswerField ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">Kind: {selectedAnswerField.kind}</Badge>
                    <Badge variant="outline">Answered: {selectedAnswerField.totalAnswered}</Badge>
                  </div>
                  <AnswerDistributionChart field={selectedAnswerField} />
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Idle Sessions</CardTitle>
            <CardDescription>Sessions currently classified as idle by timeout cron.</CardDescription>
          </CardHeader>
          <CardContent>
            {idleSessions === undefined ? (
              <p className="text-muted-foreground text-xs/relaxed">Loading idle sessions...</p>
            ) : idleSessions.length === 0 ? (
              <p className="text-muted-foreground text-xs/relaxed">No idle sessions in range.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Last activity</TableHead>
                    <TableHead>Idle age</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {idleSessions.map((session) => (
                    <TableRow key={session.sessionId}>
                      <TableCell className="font-mono text-[11px]">{session.sessionPublicId.slice(0, 8)}...</TableCell>
                      <TableCell>{formatDateTime(session.lastActivityAt)}</TableCell>
                      <TableCell>{formatRelativeMinutes(session.lastActivityAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invite Performance</CardTitle>
            <CardDescription>Quick status of invite lifecycle and completion usage.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">Total: {inviteStats.total}</Badge>
              <Badge variant="default">Active: {inviteStats.active}</Badge>
              <Badge variant="secondary">Exhausted: {inviteStats.exhausted}</Badge>
              <Badge variant="outline">Completions: {inviteStats.completions}</Badge>
            </div>

            {invites === undefined ? (
              <p className="text-muted-foreground text-xs/relaxed">Loading invites...</p>
            ) : invites.length === 0 ? (
              <p className="text-muted-foreground text-xs/relaxed">No invites yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invite</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Expires</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.slice(0, 10).map((invite) => (
                    <TableRow key={invite.inviteId}>
                      <TableCell className="font-mono text-[11px]">{invite.inviteId.slice(0, 8)}...</TableCell>
                      <TableCell>{invite.status}</TableCell>
                      <TableCell>{invite.completionCount}/{invite.maxCompletions}</TableCell>
                      <TableCell>{formatDateTime(invite.expiresAt)}</TableCell>
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

function AnswerDistributionChart({ field }: { field: AnswerBreakdown }) {
  if (field.buckets.length === 0) {
    return <p className="text-muted-foreground text-xs/relaxed">No buckets to display for this field.</p>;
  }

  const maxCount = Math.max(...field.buckets.map((bucket) => bucket.count), 1);

  return (
    <div className="space-y-2">
      {field.buckets.map((bucket, index) => {
        const widthPercent = bucket.count === 0 ? 2 : Math.max(6, (bucket.count / maxCount) * 100);
        const hueStart = (index * 37) % 360;
        const hueEnd = (hueStart + 35) % 360;

        return (
          <div key={`${field.fieldId}_${bucket.key}`} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs/relaxed">
              <span className="truncate">{bucket.label}</span>
              <span className="text-muted-foreground shrink-0">
                {bucket.count} ({bucket.percent.toFixed(2)}%)
              </span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
              <div
                className="h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${widthPercent}%`,
                  background: `linear-gradient(90deg, hsl(${hueStart} 76% 46%), hsl(${hueEnd} 72% 56%))`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value?: number | string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle>{value ?? '...'}</CardTitle>
      </CardHeader>
    </Card>
  );
}
