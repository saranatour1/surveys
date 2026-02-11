import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { DateTime } from 'luxon';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { AdminShell } from '@/components/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { convexApi } from '@/lib/convex-api';
import { buildCsvString, triggerCsvDownload } from '@/lib/csv';
import { posthogCapture } from '@/lib/posthog';
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

type TrendPoint = {
  dateKey: string;
  started: number;
  completed: number;
  idle: number;
  abandoned: number;
  conversionRate: number;
  avgScorePercent: number;
};

type DropoffStepRow = {
  fieldId: string;
  label: string;
  reachedCount: number;
  answeredCount: number;
  dropoffCount: number;
  dropoffRate: number;
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

type FieldBreakdownDetail = {
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
  dailyTrend: Array<{
    dateKey: string;
    answeredCount: number;
  }>;
  topPhrases?: Array<{
    phrase: string;
    count: number;
  }>;
  sampledText?: Array<{
    snippet: string;
    count: number;
  }>;
};

type CsvExportPayload = {
  filename: string;
  headers: string[];
  rows: string[][];
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
  const convex = useConvex();

  const [fromDate, setFromDate] = useState(DateTime.now().minus({ days: 29 }).toISODate() ?? '');
  const [toDate, setToDate] = useState(DateTime.now().toISODate() ?? '');
  const [selectedFieldId, setSelectedFieldId] = useState<string>('');
  const [insightMode, setInsightMode] = useState<'distribution' | 'trend'>('distribution');
  const [seriesVisibility, setSeriesVisibility] = useState({
    started: true,
    completed: true,
    conversionRate: true,
    avgScorePercent: false,
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingReport, setExportingReport] = useState<'funnel' | 'scoring' | 'answer_breakdown' | null>(null);

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

  const trendSeries = useQuery(convexApi.analytics.getSurveyTrendSeries, {
    surveyId,
    fromDate,
    toDate,
    interval: 'day',
  }) as TrendPoint[] | undefined;

  const dropoffRows = useQuery(convexApi.analytics.getSurveyDropoffByStep, {
    surveyId,
    fromDate,
    toDate,
  }) as DropoffStepRow[] | undefined;

  const answerBreakdown = useQuery(convexApi.analytics.getSurveyAnswerBreakdown, {
    surveyId,
    fromDate,
    toDate,
  }) as AnswerBreakdown[] | undefined;

  const fieldBreakdown = useQuery(
    convexApi.analytics.getSurveyFieldBreakdown,
    selectedFieldId
      ? {
          surveyId,
          fromDate,
          toDate,
          fieldId: selectedFieldId,
          limit: 24,
        }
      : 'skip',
  ) as FieldBreakdownDetail | undefined;

  const idleSessions = useQuery(convexApi.analytics.listIdleSessions, {
    surveyId,
    page: 0,
    limit: 100,
  }) as IdleSession[] | undefined;

  const invites = useQuery(convexApi.invites.listInvitesForSurvey, {
    surveyId,
  }) as InviteRow[] | undefined;

  useEffect(() => {
    posthogCapture('analytics_report_viewed', {
      surveyId,
      panel: 'overview',
      fromDate,
      toDate,
    });
  }, [surveyId, fromDate, toDate]);

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

  const inviteStats = useMemo(() => {
    const rows = invites ?? [];
    const total = rows.length;
    const active = rows.filter((row) => row.status === 'active').length;
    const exhausted = rows.filter((row) => row.status === 'exhausted').length;
    const completions = rows.reduce((sum, row) => sum + row.completionCount, 0);
    return { total, active, exhausted, completions };
  }, [invites]);

  const trendChartData = useMemo(
    () =>
      (trendSeries ?? []).map((row) => ({
        ...row,
        label: DateTime.fromISO(row.dateKey).toFormat('LLL dd'),
      })),
    [trendSeries],
  );

  const onToggleSeries = (key: keyof typeof seriesVisibility) => {
    setErrorMessage(null);
    setStatusMessage(null);

    const activeCount = Object.values(seriesVisibility).filter(Boolean).length;
    if (seriesVisibility[key] && activeCount === 1) {
      setStatusMessage('Keep at least one trend series visible.');
      return;
    }

    setSeriesVisibility((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const onSelectField = (fieldId: string | null) => {
    if (!fieldId) {
      return;
    }
    setSelectedFieldId(fieldId);
    setErrorMessage(null);
    setStatusMessage(null);

    const kind = answerBreakdown?.find((row) => row.fieldId === fieldId)?.kind;
    posthogCapture('analytics_field_selected', {
      surveyId,
      fieldId,
      kind,
    });
  };

  const onExportCsv = async (report: 'funnel' | 'scoring' | 'answer_breakdown') => {
    setErrorMessage(null);
    setStatusMessage(null);

    if (exportingReport) {
      setStatusMessage(`Export already running for ${exportingReport}.`);
      return;
    }

    setExportingReport(report);
    try {
      const payload = (await convex.query(convexApi.analytics.getSurveyCsvExport, {
        surveyId,
        fromDate,
        toDate,
        report,
      })) as CsvExportPayload;

      const csv = buildCsvString(payload.headers, payload.rows);
      triggerCsvDownload(payload.filename, csv);

      setStatusMessage(`Export ready: ${payload.filename}`);
      posthogCapture('analytics_csv_export_requested', {
        surveyId,
        report,
        rowCount: payload.rows.length,
      });
    } catch (error) {
      setErrorMessage(extractErrorMessage(error));
    } finally {
      setExportingReport(null);
    }
  };

  return (
    <AdminShell
      heading={`Analytics${survey?.title ? `: ${survey.title}` : ''}`}
      description="Operational analytics with trend analysis, drop-off tracking, answer insights, and CSV exports."
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
          <CardDescription>All trend slices are computed in UTC.</CardDescription>
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
          <CardTitle>Trends</CardTitle>
          <CardDescription>Track response volume, conversion, and score movement day-by-day.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={seriesVisibility.started ? 'default' : 'outline'}
              size="sm"
              onClick={() => onToggleSeries('started')}
            >
              Started
            </Button>
            <Button
              variant={seriesVisibility.completed ? 'default' : 'outline'}
              size="sm"
              onClick={() => onToggleSeries('completed')}
            >
              Completed
            </Button>
            <Button
              variant={seriesVisibility.conversionRate ? 'default' : 'outline'}
              size="sm"
              onClick={() => onToggleSeries('conversionRate')}
            >
              Conversion %
            </Button>
            <Button
              variant={seriesVisibility.avgScorePercent ? 'default' : 'outline'}
              size="sm"
              onClick={() => onToggleSeries('avgScorePercent')}
            >
              Avg Score %
            </Button>
          </div>

          {trendSeries === undefined ? (
            <p className="text-muted-foreground text-xs/relaxed">Loading trend series...</p>
          ) : trendSeries.length === 0 ? (
            <p className="text-muted-foreground text-xs/relaxed">No trend data in this range.</p>
          ) : (
            <TrendSeriesChart data={trendChartData} visibility={seriesVisibility} />
          )}
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Drop-off by Question</CardTitle>
            <CardDescription>Reached vs answered counts with per-question drop-off rates.</CardDescription>
          </CardHeader>
          <CardContent>
            {dropoffRows === undefined ? (
              <p className="text-muted-foreground text-xs/relaxed">Loading drop-off data...</p>
            ) : dropoffRows.length === 0 ? (
              <p className="text-muted-foreground text-xs/relaxed">No drop-off rows in this range.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Question</TableHead>
                    <TableHead>Reached</TableHead>
                    <TableHead>Answered</TableHead>
                    <TableHead>Drop-off</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dropoffRows.map((row) => (
                    <TableRow key={row.fieldId}>
                      <TableCell className="max-w-[220px] truncate">{row.label}</TableCell>
                      <TableCell>{row.reachedCount}</TableCell>
                      <TableCell>{row.answeredCount}</TableCell>
                      <TableCell>{row.dropoffRate.toFixed(2)}%</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => onSelectField(row.fieldId)}>
                          Inspect
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>CSV Exports</CardTitle>
            <CardDescription>Download aggregate analytics payloads for operations review.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void onExportCsv('funnel')}>
                Funnel CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => void onExportCsv('scoring')}>
                Scoring CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => void onExportCsv('answer_breakdown')}>
                Answer Breakdown CSV
              </Button>
            </div>
            {exportingReport ? <p className="text-muted-foreground text-xs/relaxed">Exporting {exportingReport}...</p> : null}
            {statusMessage ? <p className="text-xs/relaxed text-emerald-700">{statusMessage}</p> : null}
            {errorMessage ? <p className="text-destructive text-xs/relaxed">{errorMessage}</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Answer Insights</CardTitle>
          <CardDescription>Custom answer distribution and daily trend for the selected question.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {answerBreakdown === undefined ? (
            <p className="text-muted-foreground text-xs/relaxed">Loading answer insights...</p>
          ) : answerBreakdown.length === 0 ? (
            <p className="text-muted-foreground text-xs/relaxed">No submitted answers in this date range.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <Field>
                  <FieldLabel>Question</FieldLabel>
                  <Select value={selectedFieldId} onValueChange={onSelectField}>
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={insightMode === 'distribution' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setInsightMode('distribution')}
                  >
                    Distribution
                  </Button>
                  <Button
                    variant={insightMode === 'trend' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setInsightMode('trend')}
                  >
                    Daily Trend
                  </Button>
                </div>
              </div>

              {fieldBreakdown ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">Kind: {fieldBreakdown.kind}</Badge>
                    <Badge variant="outline">Answered: {fieldBreakdown.totalAnswered}</Badge>
                  </div>

                  {insightMode === 'distribution' ? (
                    <AnswerDistributionChart field={fieldBreakdown} fallbackField={selectedAnswerField} />
                  ) : (
                    <FieldTrendChart field={fieldBreakdown} />
                  )}

                  {fieldBreakdown.kind === 'short_text' || fieldBreakdown.kind === 'long_text' ? (
                    <TextInsightPanels field={fieldBreakdown} />
                  ) : null}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs/relaxed">Select a question to load detail.</p>
              )}
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

function TrendSeriesChart({
  data,
  visibility,
}: {
  data: Array<TrendPoint & { label: string }>;
  visibility: {
    started: boolean;
    completed: boolean;
    conversionRate: boolean;
    avgScorePercent: boolean;
  };
}) {
  const chartConfig = {
    started: { label: 'Started', color: 'var(--color-chart-1)' },
    completed: { label: 'Completed', color: 'var(--color-chart-2)' },
    conversionRate: { label: 'Conversion %', color: 'var(--color-chart-3)' },
    avgScorePercent: { label: 'Avg Score %', color: 'var(--color-chart-4)' },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="h-[320px] w-full">
      <LineChart data={data} margin={{ left: 8, right: 10, top: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={20} />
        <YAxis yAxisId="count" allowDecimals={false} tickLine={false} axisLine={false} width={36} />
        <YAxis yAxisId="pct" orientation="right" tickLine={false} axisLine={false} width={44} domain={[0, 100]} />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)' }}
          content={<ChartTooltipContent />}
        />
        <Line
          yAxisId="count"
          type="monotone"
          dataKey="started"
          stroke="var(--color-started)"
          strokeWidth={2}
          dot={false}
          hide={!visibility.started}
        />
        <Line
          yAxisId="count"
          type="monotone"
          dataKey="completed"
          stroke="var(--color-completed)"
          strokeWidth={2}
          dot={false}
          hide={!visibility.completed}
        />
        <Line
          yAxisId="pct"
          type="monotone"
          dataKey="conversionRate"
          stroke="var(--color-conversionRate)"
          strokeWidth={2}
          dot={false}
          hide={!visibility.conversionRate}
        />
        <Line
          yAxisId="pct"
          type="monotone"
          dataKey="avgScorePercent"
          stroke="var(--color-avgScorePercent)"
          strokeWidth={2}
          dot={false}
          hide={!visibility.avgScorePercent}
        />
      </LineChart>
    </ChartContainer>
  );
}

function AnswerDistributionChart({
  field,
  fallbackField,
}: {
  field: FieldBreakdownDetail;
  fallbackField: AnswerBreakdown | null;
}) {
  const buckets = field.buckets.length > 0 ? field.buckets : fallbackField?.buckets ?? [];
  if (buckets.length === 0) {
    return <p className="text-muted-foreground text-xs/relaxed">No buckets to display for this field.</p>;
  }

  const chartData = buckets.map((bucket) => ({
    label: bucket.label,
    count: bucket.count,
    percent: bucket.percent,
  }));

  const chartConfig = {
    count: {
      label: 'Count',
      color: 'var(--color-chart-1)',
    },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="h-[300px] w-full">
      <BarChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          angle={buckets.length > 6 ? -20 : 0}
          textAnchor={buckets.length > 6 ? 'end' : 'middle'}
          height={buckets.length > 6 ? 52 : 32}
        />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip
          cursor={{ fill: 'var(--muted)' }}
          content={
            <ChartTooltipContent
              formatter={(value, _name, item) => {
                const row = item.payload as { percent?: number };
                return `${value} (${(row.percent ?? 0).toFixed(2)}%)`;
              }}
            />
          }
        />
        <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function FieldTrendChart({ field }: { field: FieldBreakdownDetail }) {
  if (!field.dailyTrend || field.dailyTrend.length === 0) {
    return <p className="text-muted-foreground text-xs/relaxed">No daily trend data for this field.</p>;
  }

  const chartData = field.dailyTrend.map((row) => ({
    ...row,
    label: DateTime.fromISO(row.dateKey).toFormat('LLL dd'),
  }));

  const chartConfig = {
    answeredCount: {
      label: 'Answered',
      color: 'var(--color-chart-2)',
    },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="h-[260px] w-full">
      <LineChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={20} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Line dataKey="answeredCount" stroke="var(--color-answeredCount)" strokeWidth={2} dot={false} />
      </LineChart>
    </ChartContainer>
  );
}

function TextInsightPanels({ field }: { field: FieldBreakdownDetail }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardDescription>Top Phrases</CardDescription>
        </CardHeader>
        <CardContent>
          {!field.topPhrases || field.topPhrases.length === 0 ? (
            <p className="text-muted-foreground text-xs/relaxed">No phrase summary available yet.</p>
          ) : (
            <div className="space-y-1">
              {field.topPhrases.map((phrase) => (
                <div key={phrase.phrase} className="flex items-center justify-between text-xs">
                  <span className="truncate">{phrase.phrase}</span>
                  <Badge variant="outline">{phrase.count}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardDescription>Sampled Snippets</CardDescription>
        </CardHeader>
        <CardContent>
          {!field.sampledText || field.sampledText.length === 0 ? (
            <p className="text-muted-foreground text-xs/relaxed">No sampled snippets available yet.</p>
          ) : (
            <div className="space-y-2">
              {field.sampledText.map((snippet, index) => (
                <div key={`${snippet.snippet}-${index}`} className="rounded border p-2 text-xs/relaxed">
                  <p>{snippet.snippet}</p>
                  <p className="text-muted-foreground mt-1">Count: {snippet.count}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
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
  return 'Analytics action failed. Please retry.';
}
