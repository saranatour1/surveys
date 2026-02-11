import { DateTime } from 'luxon';
import { ConvexError, v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { requireAppUser } from './lib/auth';
import {
  buildDateKeys,
  getSurveyFieldMetaMap,
  parseAnalyticsDateRange,
  rebuildDailyMaterializedAnalytics,
  refreshDailyTextInsights,
} from './lib/analytics_materialization';
import {
  ANALYTICS_DEFAULT_WINDOW_DAYS,
  ANALYTICS_MAX_BUCKETS,
  ANALYTICS_MAX_CSV_ROWS,
  ANALYTICS_MAX_TOP_PHRASES,
  ANALYTICS_MAX_WINDOW_DAYS,
  POSTHOG_BATCH_LIMIT,
} from './lib/constants';
import { enqueueAnalyticsEvent } from './lib/domain';
import { fieldKindValidator, sessionStatusValidator } from './lib/validators';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

const csvReportValidator = v.union(
  v.literal('funnel'),
  v.literal('scoring'),
  v.literal('answer_breakdown'),
);

type SurveyFieldKind = Doc<'surveyVersions'>['fields'][number]['kind'];
type ReadCtx = QueryCtx | MutationCtx;

type MaterializedFieldBreakdown = {
  fieldId: string;
  label: string;
  kind: SurveyFieldKind;
  order: number;
  totalAnswered: number;
  buckets: Array<{
    key: string;
    label: string;
    count: number;
    percent: number;
  }>;
};

function assertSurveyOwnerOrAdmin(actor: Doc<'appUsers'>, survey: Doc<'surveys'>) {
  const allowed = actor.role === 'admin' || survey.createdByUserId === actor._id;
  if (!allowed) {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'You can only view analytics for surveys you created.',
    });
  }
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function toPercent(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return roundToTwo((value / total) * 100);
}

function enforceCsvRowLimit(rowCount: number) {
  if (rowCount > ANALYTICS_MAX_CSV_ROWS) {
    throw new ConvexError({
      code: 'ANALYTICS_EXPORT_TOO_LARGE',
      message: `CSV row limit exceeded (${rowCount}). Reduce date range or filter scope.`,
    });
  }
}

async function requireSurveyWithAccess(ctx: ReadCtx, surveyId: Id<'surveys'>) {
  const user = await requireAppUser(ctx);
  const survey = await ctx.db.get(surveyId);
  if (!survey) {
    return { user, survey: null as Doc<'surveys'> | null };
  }
  assertSurveyOwnerOrAdmin(user, survey);
  return { user, survey };
}

async function loadDailyAnalyticsRows(
  ctx: ReadCtx,
  surveyId: Id<'surveys'>,
  fromDate: string,
  toDate: string,
) {
  return await ctx.db
    .query('surveyAnalyticsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', surveyId).gte('dateKey', fromDate).lte('dateKey', toDate))
    .collect();
}

function normalizeBucketRows(
  kind: SurveyFieldKind,
  optionOrder: string[],
  optionLabels: Map<string, string>,
  buckets: Array<{ key: string; label: string; count: number }>,
) {
  const normalized = [...buckets];

  if (kind === 'single_select' || kind === 'multi_select') {
    for (const optionValue of optionOrder) {
      if (!normalized.some((bucket) => bucket.key === optionValue)) {
        normalized.push({
          key: optionValue,
          label: optionLabels.get(optionValue) ?? optionValue,
          count: 0,
        });
      }
    }

    normalized.sort((a, b) => optionOrder.indexOf(a.key) - optionOrder.indexOf(b.key));
    return normalized;
  }

  if (kind === 'rating_1_5') {
    for (const rating of ['1', '2', '3', '4', '5']) {
      if (!normalized.some((bucket) => bucket.key === rating)) {
        normalized.push({ key: rating, label: rating, count: 0 });
      }
    }

    normalized.sort((a, b) => Number(a.key) - Number(b.key));
    return normalized;
  }

  normalized.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (normalized.length > 20) {
    const top = normalized.slice(0, 19);
    const otherCount = normalized.slice(19).reduce((sum, row) => sum + row.count, 0);
    if (otherCount > 0) {
      top.push({ key: '__other__', label: 'Other', count: otherCount });
    }
    return top;
  }

  return normalized;
}

async function buildAnswerBreakdownFromMaterialized(
  ctx: ReadCtx,
  args: {
    surveyId: Id<'surveys'>;
    fromDate: string;
    toDate: string;
  },
): Promise<MaterializedFieldBreakdown[]> {
  const fieldMeta = await getSurveyFieldMetaMap(ctx, args.surveyId);

  const fieldRows = await ctx.db
    .query('surveyFieldAnalyticsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).gte('dateKey', args.fromDate).lte('dateKey', args.toDate))
    .collect();

  const bucketRows = await ctx.db
    .query('surveyAnswerBucketsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).gte('dateKey', args.fromDate).lte('dateKey', args.toDate))
    .collect();

  const answeredByField = new Map<string, number>();
  for (const row of fieldRows) {
    answeredByField.set(row.fieldId, (answeredByField.get(row.fieldId) ?? 0) + row.answeredCount);
  }

  const bucketMapByField = new Map<string, Map<string, { label: string; count: number }>>();
  for (const row of bucketRows) {
    const perField = bucketMapByField.get(row.fieldId) ?? new Map<string, { label: string; count: number }>();
    const existing = perField.get(row.bucketKey) ?? { label: row.bucketLabel, count: 0 };
    existing.count += row.count;
    existing.label = row.bucketLabel;
    perField.set(row.bucketKey, existing);
    bucketMapByField.set(row.fieldId, perField);
  }

  const fieldIds = new Set<string>([
    ...Array.from(answeredByField.keys()),
    ...Array.from(bucketMapByField.keys()),
  ]);

  const rows: MaterializedFieldBreakdown[] = [];
  for (const fieldId of fieldIds) {
    const meta = fieldMeta.get(fieldId);
    const totalAnswered = answeredByField.get(fieldId) ?? 0;
    if (!meta || totalAnswered <= 0) {
      continue;
    }

    const buckets = Array.from(bucketMapByField.get(fieldId)?.entries() ?? []).map(([key, value]) => ({
      key,
      label: value.label,
      count: value.count,
    }));

    const normalized = normalizeBucketRows(meta.kind, meta.optionOrder, meta.optionLabels, buckets);

    rows.push({
      fieldId,
      label: meta.label,
      kind: meta.kind,
      order: meta.order,
      totalAnswered,
      buckets: normalized.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        count: bucket.count,
        percent: toPercent(bucket.count, totalAnswered),
      })),
    });
  }

  return rows.sort((a, b) => a.order - b.order);
}

export const getSurveyFunnel = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
  },
  returns: v.object({
    started: v.number(),
    completed: v.number(),
    idle: v.number(),
    abandoned: v.number(),
    reactivated: v.number(),
    conversionRate: v.number(),
  }),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      return {
        started: 0,
        completed: 0,
        idle: 0,
        abandoned: 0,
        reactivated: 0,
        conversionRate: 0,
      };
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    const rows = await loadDailyAnalyticsRows(ctx, args.surveyId, range.fromDate, range.toDate);
    const totals = rows.reduce(
      (acc, row) => {
        acc.started += row.started;
        acc.completed += row.completed;
        acc.idle += row.idle;
        acc.abandoned += row.abandoned;
        acc.reactivated += row.reactivated;
        return acc;
      },
      {
        started: 0,
        completed: 0,
        idle: 0,
        abandoned: 0,
        reactivated: 0,
      },
    );

    return {
      ...totals,
      conversionRate: toPercent(totals.completed, totals.started),
    };
  },
});

export const getSurveyScoringSummary = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
  },
  returns: v.object({
    gradedResponses: v.number(),
    avgScorePercent: v.number(),
    totalCorrect: v.number(),
    totalIncorrect: v.number(),
  }),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      return {
        gradedResponses: 0,
        avgScorePercent: 0,
        totalCorrect: 0,
        totalIncorrect: 0,
      };
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    const rows = await loadDailyAnalyticsRows(ctx, args.surveyId, range.fromDate, range.toDate);
    const gradedResponses = rows.reduce((sum, row) => sum + row.totalGraded, 0);
    const scoreWeightedSum = rows.reduce((sum, row) => sum + row.avgScorePercent * row.totalGraded, 0);
    const avgScorePercent = gradedResponses > 0 ? roundToTwo(scoreWeightedSum / gradedResponses) : 0;

    // Keep compatibility with current scoring cards by computing total correct/incorrect from response grading payload.
    const responses = await ctx.db
      .query('surveyResponses')
      .withIndex('by_survey_id', (q) => q.eq('surveyId', args.surveyId))
      .collect();

    const filtered = responses.filter(
      (response) => response.submittedAt >= range.fromMillis && response.submittedAt <= range.toMillis,
    );

    const totalCorrect = filtered.reduce((sum, row) => sum + (row.grading?.correctCount ?? 0), 0);
    const totalIncorrect = filtered.reduce((sum, row) => sum + (row.grading?.incorrectCount ?? 0), 0);

    return {
      gradedResponses,
      avgScorePercent,
      totalCorrect,
      totalIncorrect,
    };
  },
});

export const getSurveyTrendSeries = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
    interval: v.literal('day'),
  },
  returns: v.array(
    v.object({
      dateKey: v.string(),
      started: v.number(),
      completed: v.number(),
      idle: v.number(),
      abandoned: v.number(),
      conversionRate: v.number(),
      avgScorePercent: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      return [];
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    const rows = await loadDailyAnalyticsRows(ctx, args.surveyId, range.fromDate, range.toDate);
    const byDate = new Map(rows.map((row) => [row.dateKey, row]));

    return range.dayKeys.map((dateKey) => {
      const row = byDate.get(dateKey);
      const started = row?.started ?? 0;
      const completed = row?.completed ?? 0;
      return {
        dateKey,
        started,
        completed,
        idle: row?.idle ?? 0,
        abandoned: row?.abandoned ?? 0,
        conversionRate: toPercent(completed, started),
        avgScorePercent: row?.avgScorePercent ?? 0,
      };
    });
  },
});

export const getSurveyAnswerBreakdown = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
  },
  returns: v.array(
    v.object({
      fieldId: v.string(),
      label: v.string(),
      kind: fieldKindValidator,
      totalAnswered: v.number(),
      buckets: v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          count: v.number(),
          percent: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      return [];
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    const rows = await buildAnswerBreakdownFromMaterialized(ctx, {
      surveyId: args.surveyId,
      fromDate: range.fromDate,
      toDate: range.toDate,
    });

    return rows.map((row) => ({
      fieldId: row.fieldId,
      label: row.label,
      kind: row.kind,
      totalAnswered: row.totalAnswered,
      buckets: row.buckets,
    }));
  },
});

export const getSurveyFieldBreakdown = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
    fieldId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    fieldId: v.string(),
    label: v.string(),
    kind: fieldKindValidator,
    totalAnswered: v.number(),
    buckets: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        count: v.number(),
        percent: v.number(),
      }),
    ),
    dailyTrend: v.array(
      v.object({
        dateKey: v.string(),
        answeredCount: v.number(),
      }),
    ),
    topPhrases: v.optional(
      v.array(
        v.object({
          phrase: v.string(),
          count: v.number(),
        }),
      ),
    ),
    sampledText: v.optional(
      v.array(
        v.object({
          snippet: v.string(),
          count: v.number(),
        }),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Survey not found.',
      });
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    const fieldMeta = await getSurveyFieldMetaMap(ctx, args.surveyId);
    const meta = fieldMeta.get(args.fieldId);
    if (!meta) {
      throw new ConvexError({
        code: 'FIELD_NOT_FOUND',
        message: `Unknown field: ${args.fieldId}`,
      });
    }

    const bucketLimit = Math.max(1, Math.min(args.limit ?? 20, ANALYTICS_MAX_BUCKETS));

    const fieldRows = await ctx.db
      .query('surveyFieldAnalyticsDaily')
      .withIndex('by_survey_field_and_date', (q) =>
        q.eq('surveyId', args.surveyId).eq('fieldId', args.fieldId).gte('dateKey', range.fromDate).lte('dateKey', range.toDate),
      )
      .collect();

    const answeredByDate = new Map<string, number>();
    let totalAnswered = 0;
    for (const row of fieldRows) {
      totalAnswered += row.answeredCount;
      answeredByDate.set(row.dateKey, (answeredByDate.get(row.dateKey) ?? 0) + row.answeredCount);
    }

    const bucketRows = await ctx.db
      .query('surveyAnswerBucketsDaily')
      .withIndex('by_survey_field_date', (q) =>
        q.eq('surveyId', args.surveyId).eq('fieldId', args.fieldId).gte('dateKey', range.fromDate).lte('dateKey', range.toDate),
      )
      .collect();

    const bucketCounts = new Map<string, { label: string; count: number }>();
    for (const row of bucketRows) {
      const existing = bucketCounts.get(row.bucketKey) ?? { label: row.bucketLabel, count: 0 };
      existing.count += row.count;
      existing.label = row.bucketLabel;
      bucketCounts.set(row.bucketKey, existing);
    }

    const normalizedBuckets = normalizeBucketRows(
      meta.kind,
      meta.optionOrder,
      meta.optionLabels,
      Array.from(bucketCounts.entries()).map(([key, value]) => ({
        key,
        label: value.label,
        count: value.count,
      })),
    ).slice(0, bucketLimit);

    const dailyTrend = range.dayKeys.map((dateKey) => ({
      dateKey,
      answeredCount: answeredByDate.get(dateKey) ?? 0,
    }));

    if (meta.kind !== 'short_text' && meta.kind !== 'long_text') {
      return {
        fieldId: args.fieldId,
        label: meta.label,
        kind: meta.kind,
        totalAnswered,
        buckets: normalizedBuckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          count: bucket.count,
          percent: toPercent(bucket.count, totalAnswered),
        })),
        dailyTrend,
      };
    }

    const textRows = await ctx.db
      .query('surveyTextInsightsDaily')
      .withIndex('by_survey_field_and_date', (q) =>
        q.eq('surveyId', args.surveyId).eq('fieldId', args.fieldId).gte('dateKey', range.fromDate).lte('dateKey', range.toDate),
      )
      .collect();

    const phraseCounts = new Map<string, number>();
    const snippetCounts = new Map<string, number>();

    for (const row of textRows) {
      for (const phraseRow of row.topPhrases) {
        phraseCounts.set(phraseRow.phrase, (phraseCounts.get(phraseRow.phrase) ?? 0) + phraseRow.count);
      }
      for (const snippetRow of row.sampledSnippets) {
        snippetCounts.set(snippetRow.snippet, (snippetCounts.get(snippetRow.snippet) ?? 0) + snippetRow.count);
      }
    }

    const topPhrases = Array.from(phraseCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, ANALYTICS_MAX_TOP_PHRASES)
      .map(([phrase, count]) => ({ phrase, count }));

    const sampledText = Array.from(snippetCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([snippet, count]) => ({ snippet, count }));

    return {
      fieldId: args.fieldId,
      label: meta.label,
      kind: meta.kind,
      totalAnswered,
      buckets: normalizedBuckets.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        count: bucket.count,
        percent: toPercent(bucket.count, totalAnswered),
      })),
      dailyTrend,
      topPhrases,
      sampledText,
    };
  },
});

export const getSurveyDropoffByStep = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
  },
  returns: v.array(
    v.object({
      fieldId: v.string(),
      label: v.string(),
      reachedCount: v.number(),
      answeredCount: v.number(),
      dropoffCount: v.number(),
      dropoffRate: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      return [];
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    const fieldMeta = await getSurveyFieldMetaMap(ctx, args.surveyId);
    const rows = await ctx.db
      .query('surveyFieldAnalyticsDaily')
      .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).gte('dateKey', range.fromDate).lte('dateKey', range.toDate))
      .collect();

    const aggregate = new Map<string, { reachedCount: number; answeredCount: number; dropoffCount: number }>();
    for (const row of rows) {
      const existing = aggregate.get(row.fieldId) ?? { reachedCount: 0, answeredCount: 0, dropoffCount: 0 };
      existing.reachedCount += row.reachedCount;
      existing.answeredCount += row.answeredCount;
      existing.dropoffCount += row.dropoffCount;
      aggregate.set(row.fieldId, existing);
    }

    const mapped = Array.from(aggregate.entries())
      .map(([fieldId, value]) => {
        const meta = fieldMeta.get(fieldId);
        if (!meta) {
          return null;
        }
        return {
          fieldId,
          label: meta.label,
          order: meta.order,
          reachedCount: value.reachedCount,
          answeredCount: value.answeredCount,
          dropoffCount: value.dropoffCount,
          dropoffRate: toPercent(value.dropoffCount, value.reachedCount),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => a.order - b.order)
      .map((row) => ({
        fieldId: row.fieldId,
        label: row.label,
        reachedCount: row.reachedCount,
        answeredCount: row.answeredCount,
        dropoffCount: row.dropoffCount,
        dropoffRate: row.dropoffRate,
      }));

    return mapped;
  },
});

export const getSurveyCsvExport = query({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
    report: csvReportValidator,
  },
  returns: v.object({
    filename: v.string(),
    headers: v.array(v.string()),
    rows: v.array(v.array(v.string())),
  }),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'Survey not found.',
      });
    }

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    if (args.report === 'funnel') {
      const trendRows = await loadDailyAnalyticsRows(ctx, args.surveyId, range.fromDate, range.toDate);
      const trendByDate = new Map(trendRows.map((row) => [row.dateKey, row]));

      const headers = ['dateKey', 'started', 'completed', 'idle', 'abandoned', 'reactivated', 'conversionRate', 'avgScorePercent'];
      const rows = range.dayKeys.map((dateKey) => {
        const row = trendByDate.get(dateKey);
        const started = row?.started ?? 0;
        const completed = row?.completed ?? 0;
        return [
          dateKey,
          String(started),
          String(completed),
          String(row?.idle ?? 0),
          String(row?.abandoned ?? 0),
          String(row?.reactivated ?? 0),
          toPercent(completed, started).toFixed(2),
          (row?.avgScorePercent ?? 0).toFixed(2),
        ];
      });

      enforceCsvRowLimit(rows.length);
      return {
        filename: `survey_${args.surveyId}_funnel_${range.fromDate}_to_${range.toDate}.csv`,
        headers,
        rows,
      };
    }

    if (args.report === 'scoring') {
      const trendRows = await loadDailyAnalyticsRows(ctx, args.surveyId, range.fromDate, range.toDate);
      const trendByDate = new Map(trendRows.map((row) => [row.dateKey, row]));

      const headers = ['dateKey', 'totalGraded', 'avgScorePercent'];
      const rows = range.dayKeys.map((dateKey) => {
        const row = trendByDate.get(dateKey);
        return [dateKey, String(row?.totalGraded ?? 0), (row?.avgScorePercent ?? 0).toFixed(2)];
      });

      enforceCsvRowLimit(rows.length);
      return {
        filename: `survey_${args.surveyId}_scoring_${range.fromDate}_to_${range.toDate}.csv`,
        headers,
        rows,
      };
    }

    const breakdownRows = await buildAnswerBreakdownFromMaterialized(ctx, {
      surveyId: args.surveyId,
      fromDate: range.fromDate,
      toDate: range.toDate,
    });

    const headers = ['fieldId', 'label', 'kind', 'totalAnswered', 'bucketKey', 'bucketLabel', 'bucketCount', 'bucketPercent'];
    const rows = breakdownRows.flatMap((field) =>
      field.buckets.map((bucket) => [
        field.fieldId,
        field.label,
        field.kind,
        String(field.totalAnswered),
        bucket.key,
        bucket.label,
        String(bucket.count),
        bucket.percent.toFixed(2),
      ]),
    );

    enforceCsvRowLimit(rows.length);
    return {
      filename: `survey_${args.surveyId}_answer_breakdown_${range.fromDate}_to_${range.toDate}.csv`,
      headers,
      rows,
    };
  },
});

export const listIdleSessions = query({
  args: {
    surveyId: v.id('surveys'),
    page: v.number(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      sessionId: v.id('surveySessions'),
      sessionPublicId: v.string(),
      status: sessionStatusValidator,
      startedAt: v.number(),
      lastActivityAt: v.number(),
      idleMinutes: v.number(),
      inviteId: v.id('surveyInvites'),
    }),
  ),
  handler: async (ctx, args) => {
    const { survey } = await requireSurveyWithAccess(ctx, args.surveyId);
    if (!survey) {
      return [];
    }

    const page = Math.max(0, Math.floor(args.page));
    const limit = Math.max(1, Math.min(Math.floor(args.limit), 200));
    const now = DateTime.utc();

    const rows = await ctx.db
      .query('surveySessions')
      .withIndex('by_survey_and_status', (q) => q.eq('surveyId', args.surveyId).eq('status', 'idle'))
      .order('desc')
      .collect();

    return rows.slice(page * limit, page * limit + limit).map((row) => ({
      sessionId: row._id,
      sessionPublicId: row.sessionPublicId,
      status: row.status,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      idleMinutes: Math.max(0, Math.floor(now.diff(DateTime.fromMillis(row.lastActivityAt), 'minutes').minutes)),
      inviteId: row.inviteId,
    }));
  },
});

export const incrementalIngestResponse = internalMutation({
  args: {
    responseId: v.id('surveyResponses'),
  },
  returns: v.object({
    processed: v.boolean(),
    dateKey: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const response = await ctx.db.get(args.responseId);
    if (!response) {
      return { processed: false, dateKey: undefined };
    }

    const dateKey = DateTime.fromMillis(response.submittedAt, { zone: 'utc' }).toISODate() ?? '1970-01-01';
    await rebuildDailyMaterializedAnalytics(ctx, {
      surveyId: response.surveyId,
      dateKey,
      includeTextInsights: false,
    });

    return {
      processed: true,
      dateKey,
    };
  },
});

export const rebuildMaterializedWindow = internalMutation({
  args: {
    surveyId: v.id('surveys'),
    fromDate: v.string(),
    toDate: v.string(),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    daysProcessed: v.number(),
  }),
  handler: async (ctx, args) => {
    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate,
      toDate: args.toDate,
      maxDays: ANALYTICS_MAX_WINDOW_DAYS,
    });

    for (const dateKey of range.dayKeys) {
      await rebuildDailyMaterializedAnalytics(ctx, {
        surveyId: args.surveyId,
        dateKey,
        includeTextInsights: true,
      });
    }

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'analytics_rebuild_triggered',
      distinctId: `survey:${args.surveyId}`,
      properties: {
        surveyId: args.surveyId,
        fromDate: range.fromDate,
        toDate: range.toDate,
        reason: args.reason ?? 'manual_or_internal',
      },
    });

    return { daysProcessed: range.dayKeys.length };
  },
});

export const refreshTextSummariesBatch = internalMutation({
  args: {
    surveyId: v.optional(v.id('surveys')),
    fromDate: v.optional(v.string()),
    toDate: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    surveysProcessed: v.number(),
    daysProcessed: v.number(),
  }),
  handler: async (ctx, args) => {
    const defaultToDate = DateTime.utc().toISODate() ?? '1970-01-01';
    const defaultFromDate = DateTime.utc().minus({ days: 2 }).toISODate() ?? defaultToDate;

    const range = parseAnalyticsDateRange({
      fromDate: args.fromDate ?? defaultFromDate,
      toDate: args.toDate ?? defaultToDate,
      maxDays: 31,
    });

    const days = args.limit
      ? range.dayKeys.slice(0, Math.max(1, Math.min(args.limit, range.dayKeys.length)))
      : range.dayKeys;

    const surveyIds: Id<'surveys'>[] = [];
    if (args.surveyId) {
      surveyIds.push(args.surveyId);
    } else {
      const surveys = await ctx.db.query('surveys').withIndex('by_updated_at').order('desc').take(200);
      for (const survey of surveys) {
        surveyIds.push(survey._id);
      }
    }

    let daysProcessed = 0;
    for (const surveyId of surveyIds) {
      for (const dateKey of days) {
        await refreshDailyTextInsights(ctx, {
          surveyId,
          dateKey,
        });
        daysProcessed += 1;
      }
    }

    return {
      surveysProcessed: surveyIds.length,
      daysProcessed,
    };
  },
});

export const rebuildRecentWindowForAllSurveys = internalMutation({
  args: {
    lookbackDays: v.optional(v.number()),
    surveyLimit: v.optional(v.number()),
  },
  returns: v.object({
    surveysProcessed: v.number(),
    daysProcessed: v.number(),
  }),
  handler: async (ctx, args) => {
    const lookbackDays = Math.max(1, Math.min(args.lookbackDays ?? 2, ANALYTICS_DEFAULT_WINDOW_DAYS));
    const surveyLimit = Math.max(1, Math.min(args.surveyLimit ?? 200, 500));
    const toDate = DateTime.utc().toISODate() ?? '1970-01-01';
    const fromDate = DateTime.utc().minus({ days: lookbackDays - 1 }).toISODate() ?? toDate;
    const dayKeys = buildDateKeys(fromDate, toDate);

    const surveys = await ctx.db.query('surveys').withIndex('by_updated_at').order('desc').take(surveyLimit);

    let daysProcessed = 0;
    for (const survey of surveys) {
      for (const dateKey of dayKeys) {
        await rebuildDailyMaterializedAnalytics(ctx, {
          surveyId: survey._id,
          dateKey,
          includeTextInsights: false,
        });
        daysProcessed += 1;
      }
    }

    return {
      surveysProcessed: surveys.length,
      daysProcessed,
    };
  },
});

export const enqueue = internalMutation({
  args: {
    eventName: v.string(),
    distinctId: v.string(),
    properties: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await enqueueAnalyticsEvent(ctx, args);
    return null;
  },
});

export const listDueOutboxEvents = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      outboxId: v.id('analyticsOutbox'),
      eventName: v.string(),
      distinctId: v.string(),
      properties: v.any(),
      attemptCount: v.number(),
      nextAttemptAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? POSTHOG_BATCH_LIMIT, POSTHOG_BATCH_LIMIT));

    const events = await ctx.db
      .query('analyticsOutbox')
      .withIndex('by_status_and_next_attempt', (q) => q.eq('status', 'pending').lte('nextAttemptAt', now))
      .take(limit);

    return events.map((event) => ({
      outboxId: event._id,
      eventName: event.eventName,
      distinctId: event.distinctId,
      properties: event.properties,
      attemptCount: event.attemptCount,
      nextAttemptAt: event.nextAttemptAt,
    }));
  },
});

export const recordOutboxDispatch = internalMutation({
  args: {
    outboxId: v.id('analyticsOutbox'),
    success: v.boolean(),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboxId);
    if (!row) {
      return null;
    }

    const now = Date.now();

    if (args.success) {
      await ctx.db.patch(row._id, {
        status: 'sent',
        sentAt: now,
        attemptCount: row.attemptCount + 1,
        lastError: undefined,
      });
      return null;
    }

    const attemptCount = row.attemptCount + 1;
    const retryDelayMs = Math.min(2 ** Math.min(attemptCount, 10) * 1000, 30 * 60 * 1000);
    const shouldFailPermanently = attemptCount >= 8;

    await ctx.db.patch(row._id, {
      status: shouldFailPermanently ? 'failed' : 'pending',
      attemptCount,
      nextAttemptAt: now + retryDelayMs,
      lastError: args.errorMessage,
    });

    return null;
  },
});

export const flushOutbox = internalAction({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.object({ processed: v.number(), sent: v.number(), failed: v.number() }),
  handler: async (ctx, args): Promise<{ processed: number; sent: number; failed: number }> => {
    const apiKey = process.env.POSTHOG_API_KEY;
    const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

    if (!apiKey) {
      return { processed: 0, sent: 0, failed: 0 };
    }

    const generatedApi = (await import('./_generated/api')) as any;
    const dueEvents = (await ctx.runQuery(generatedApi.internal.analytics.listDueOutboxEvents, {
      limit: args.limit,
    })) as Array<{
      outboxId: string;
      eventName: string;
      distinctId: string;
      properties: Record<string, unknown>;
    }>;

    let sent = 0;
    let failed = 0;

    for (const event of dueEvents) {
      try {
        const payload = {
          api_key: apiKey,
          event: event.eventName,
          properties: {
            ...(event.properties ?? {}),
            distinct_id: event.distinctId,
          },
        };

        const response = await fetch(`${host.replace(/\/$/, '')}/capture/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HTTP ${response.status}: ${body}`);
        }

        await ctx.runMutation(generatedApi.internal.analytics.recordOutboxDispatch, {
          outboxId: event.outboxId,
          success: true,
        });

        sent += 1;
      } catch (error) {
        await ctx.runMutation(generatedApi.internal.analytics.recordOutboxDispatch, {
          outboxId: event.outboxId,
          success: false,
          errorMessage: error instanceof Error ? error.message : 'Unknown PostHog dispatch error',
        });
        failed += 1;
      }
    }

    return {
      processed: dueEvents.length,
      sent,
      failed,
    };
  },
});
