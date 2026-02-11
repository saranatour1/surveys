import { DateTime } from 'luxon';
import { ConvexError, v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, query } from './_generated/server';
import { requireAppUser } from './lib/auth';
import { enqueueAnalyticsEvent } from './lib/domain';
import { POSTHOG_BATCH_LIMIT } from './lib/constants';
import { fieldKindValidator, sessionStatusValidator } from './lib/validators';
import type { Doc } from './_generated/dataModel';

function validateDateKey(dateKey: string): string {
  const parsed = DateTime.fromISO(dateKey, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return parsed.toISODate() ?? dateKey;
}

function assertSurveyOwnerOrAdmin(actor: Doc<'appUsers'>, survey: Doc<'surveys'>) {
  const allowed = actor.role === 'admin' || survey.createdByUserId === actor._id;
  if (!allowed) {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'You can only view analytics for surveys you created.',
    });
  }
}

function isAnswerPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function truncateLabel(value: string, max = 64): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function formatAnswerBucketEntries(
  field: Doc<'surveyVersions'>['fields'][number],
  value: unknown,
): Array<{ key: string; label: string }> {
  const optionLabelByValue = new Map((field.options ?? []).map((option) => [option.value, option.label]));

  if (field.kind === 'multi_select') {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => ({
        key: entry,
        label: truncateLabel(optionLabelByValue.get(entry) ?? entry),
      }));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (field.kind === 'single_select') {
      return [
        {
          key: trimmed,
          label: truncateLabel(optionLabelByValue.get(trimmed) ?? trimmed),
        },
      ];
    }

    return [
      {
        key: trimmed,
        label: truncateLabel(trimmed),
      },
    ];
  }

  if (typeof value === 'number') {
    const key = Number.isInteger(value) ? String(value) : value.toFixed(2);
    return [{ key, label: key }];
  }

  if (typeof value === 'boolean') {
    return [{ key: value ? 'true' : 'false', label: value ? 'True' : 'False' }];
  }

  return [];
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
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
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
    assertSurveyOwnerOrAdmin(user, survey);

    const fromDate = validateDateKey(args.fromDate);
    const toDate = validateDateKey(args.toDate);

    const metrics = await ctx.db
      .query('surveyMetricsDaily')
      .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).gte('dateKey', fromDate).lte('dateKey', toDate))
      .collect();

    const totals = metrics.reduce(
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

    const conversionRate = totals.started > 0 ? Math.round((totals.completed / totals.started) * 10000) / 100 : 0;

    return {
      ...totals,
      conversionRate,
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
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      return {
        gradedResponses: 0,
        avgScorePercent: 0,
        totalCorrect: 0,
        totalIncorrect: 0,
      };
    }
    assertSurveyOwnerOrAdmin(user, survey);

    const fromDate = validateDateKey(args.fromDate);
    const toDate = validateDateKey(args.toDate);
    const fromMillis = DateTime.fromISO(fromDate, { zone: 'utc' }).startOf('day').toMillis();
    const toMillis = DateTime.fromISO(toDate, { zone: 'utc' }).endOf('day').toMillis();

    const responses = await ctx.db
      .query('surveyResponses')
      .withIndex('by_survey_id', (q) => q.eq('surveyId', args.surveyId))
      .collect();

    const graded = responses.filter(
      (response) =>
        response.submittedAt >= fromMillis &&
        response.submittedAt <= toMillis &&
        response.grading !== undefined,
    );

    const totalCorrect = graded.reduce((sum, row) => sum + (row.grading?.correctCount ?? 0), 0);
    const totalIncorrect = graded.reduce((sum, row) => sum + (row.grading?.incorrectCount ?? 0), 0);
    const sumScore = graded.reduce((sum, row) => sum + (row.grading?.scorePercent ?? 0), 0);
    const gradedResponses = graded.length;
    const avgScorePercent = gradedResponses > 0 ? Math.round((sumScore / gradedResponses) * 100) / 100 : 0;

    return {
      gradedResponses,
      avgScorePercent,
      totalCorrect,
      totalIncorrect,
    };
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
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      return [];
    }
    assertSurveyOwnerOrAdmin(user, survey);

    const fromDate = validateDateKey(args.fromDate);
    const toDate = validateDateKey(args.toDate);
    const fromMillis = DateTime.fromISO(fromDate, { zone: 'utc' }).startOf('day').toMillis();
    const toMillis = DateTime.fromISO(toDate, { zone: 'utc' }).endOf('day').toMillis();

    const responses = await ctx.db
      .query('surveyResponses')
      .withIndex('by_survey_id', (q) => q.eq('surveyId', args.surveyId))
      .collect();

    const filtered = responses.filter(
      (response) => response.submittedAt >= fromMillis && response.submittedAt <= toMillis,
    );

    if (filtered.length === 0) {
      return [];
    }

    const versionCache = new Map<Doc<'surveyResponses'>['surveyVersionId'], Doc<'surveyVersions'> | null>();
    const fieldMeta = new Map<
      string,
      {
        label: string;
        kind: Doc<'surveyVersions'>['fields'][number]['kind'];
        order: number;
        optionOrder: string[];
        optionLabels: Map<string, string>;
      }
    >();
    const totalAnsweredByField = new Map<string, number>();
    const bucketCountByField = new Map<string, Map<string, { label: string; count: number }>>();

    for (const response of filtered) {
      let version = versionCache.get(response.surveyVersionId);
      if (version === undefined) {
        version = await ctx.db.get(response.surveyVersionId);
        versionCache.set(response.surveyVersionId, version);
      }
      if (!version) {
        continue;
      }

      for (const field of version.fields) {
        const existingMeta = fieldMeta.get(field.id);
        if (!existingMeta) {
          fieldMeta.set(field.id, {
            label: field.label,
            kind: field.kind,
            order: field.order,
            optionOrder: (field.options ?? []).map((option) => option.value),
            optionLabels: new Map((field.options ?? []).map((option) => [option.value, option.label])),
          });
        } else if (field.order < existingMeta.order) {
          existingMeta.order = field.order;
        }

        const answer = response.answers[field.id];
        if (!isAnswerPresent(answer)) {
          continue;
        }

        totalAnsweredByField.set(field.id, (totalAnsweredByField.get(field.id) ?? 0) + 1);
        const entries = formatAnswerBucketEntries(field, answer);
        if (entries.length === 0) {
          continue;
        }

        const bucketMap = bucketCountByField.get(field.id) ?? new Map<string, { label: string; count: number }>();
        bucketCountByField.set(field.id, bucketMap);

        for (const entry of entries) {
          const bucket = bucketMap.get(entry.key) ?? { label: entry.label, count: 0 };
          bucket.count += 1;
          bucketMap.set(entry.key, bucket);
        }
      }
    }

    return Array.from(fieldMeta.entries())
      .map(([fieldId, meta]) => {
        const totalAnswered = totalAnsweredByField.get(fieldId) ?? 0;
        if (totalAnswered === 0) {
          return null;
        }

        const bucketMap = bucketCountByField.get(fieldId) ?? new Map<string, { label: string; count: number }>();
        const bucketRows = Array.from(bucketMap.entries()).map(([key, bucket]) => ({
          key,
          label: bucket.label,
          count: bucket.count,
        }));

        if (meta.kind === 'single_select' || meta.kind === 'multi_select') {
          for (const optionValue of meta.optionOrder) {
            if (!bucketMap.has(optionValue)) {
              bucketRows.push({
                key: optionValue,
                label: meta.optionLabels.get(optionValue) ?? optionValue,
                count: 0,
              });
            }
          }
          bucketRows.sort((a, b) => {
            const indexA = meta.optionOrder.indexOf(a.key);
            const indexB = meta.optionOrder.indexOf(b.key);
            return indexA - indexB;
          });
        } else if (meta.kind === 'rating_1_5') {
          const allRatings = ['1', '2', '3', '4', '5'];
          for (const rating of allRatings) {
            if (!bucketMap.has(rating)) {
              bucketRows.push({ key: rating, label: rating, count: 0 });
            }
          }
          bucketRows.sort((a, b) => Number(a.key) - Number(b.key));
        } else {
          bucketRows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        }

        let normalizedBuckets = bucketRows;
        if (meta.kind !== 'single_select' && meta.kind !== 'multi_select' && meta.kind !== 'rating_1_5') {
          if (normalizedBuckets.length > 12) {
            const top = normalizedBuckets.slice(0, 11);
            const otherCount = normalizedBuckets.slice(11).reduce((sum, row) => sum + row.count, 0);
            normalizedBuckets = otherCount > 0 ? [...top, { key: '__other__', label: 'Other', count: otherCount }] : top;
          }
        }

        return {
          fieldId,
          label: meta.label,
          kind: meta.kind,
          totalAnswered,
          buckets: normalizedBuckets.map((bucket) => ({
            key: bucket.key,
            label: bucket.label,
            count: bucket.count,
            percent: totalAnswered > 0 ? Math.round((bucket.count / totalAnswered) * 10000) / 100 : 0,
          })),
          order: meta.order,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => a.order - b.order)
      .map((row) => ({
        fieldId: row.fieldId,
        label: row.label,
        kind: row.kind,
        totalAnswered: row.totalAnswered,
        buckets: row.buckets,
      }));
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
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      return [];
    }
    assertSurveyOwnerOrAdmin(user, survey);

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
