import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { dateKeyFromTimestamp } from './utils';

export async function bumpDailyMetric(
  ctx: MutationCtx,
  args: {
    surveyId: Id<'surveys'>;
    metric: 'started' | 'completed' | 'idle' | 'abandoned' | 'reactivated';
    delta?: number;
    timestamp?: number;
  },
) {
  const timestamp = args.timestamp ?? Date.now();
  const dateKey = dateKeyFromTimestamp(timestamp);
  const delta = args.delta ?? 1;

  const existing = await ctx.db
    .query('surveyMetricsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).eq('dateKey', dateKey))
    .unique();

  const base = existing ?? {
    surveyId: args.surveyId,
    dateKey,
    started: 0,
    completed: 0,
    idle: 0,
    abandoned: 0,
    reactivated: 0,
    updatedAt: timestamp,
  };

  const nextValue = (base[args.metric] ?? 0) + delta;
  const patch = {
    ...base,
    [args.metric]: Math.max(nextValue, 0),
    updatedAt: timestamp,
  };

  if (!existing) {
    await ctx.db.insert('surveyMetricsDaily', patch);
  } else {
    await ctx.db.patch(existing._id, patch);
  }

  // Keep analytics rollups warm for near real-time dashboard reads.
  const analyticsExisting = await ctx.db
    .query('surveyAnalyticsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).eq('dateKey', dateKey))
    .unique();

  const analyticsBase = analyticsExisting ?? {
    surveyId: args.surveyId,
    dateKey,
    started: 0,
    completed: 0,
    idle: 0,
    abandoned: 0,
    reactivated: 0,
    avgScorePercent: 0,
    totalGraded: 0,
    updatedAt: timestamp,
  };

  const analyticsNextValue = (analyticsBase[args.metric] ?? 0) + delta;
  const analyticsPatch = {
    ...analyticsBase,
    [args.metric]: Math.max(analyticsNextValue, 0),
    updatedAt: timestamp,
  };

  if (!analyticsExisting) {
    await ctx.db.insert('surveyAnalyticsDaily', analyticsPatch);
  } else {
    await ctx.db.patch(analyticsExisting._id, analyticsPatch);
  }
}

export async function writeTransition(
  ctx: MutationCtx,
  args: {
    sessionId: Id<'surveySessions'>;
    surveyId: Id<'surveys'>;
    fromStatus?: 'in_progress' | 'idle' | 'abandoned' | 'completed';
    toStatus: 'in_progress' | 'idle' | 'abandoned' | 'completed';
    reason: string;
    at?: number;
  },
) {
  const at = args.at ?? Date.now();
  await ctx.db.insert('sessionTransitions', {
    sessionId: args.sessionId,
    surveyId: args.surveyId,
    fromStatus: args.fromStatus,
    toStatus: args.toStatus,
    reason: args.reason,
    at,
  });
}

export async function enqueueAnalyticsEvent(
  ctx: MutationCtx,
  args: {
    eventName: string;
    distinctId: string;
    properties: Record<string, unknown>;
  },
) {
  const now = Date.now();
  await ctx.db.insert('analyticsOutbox', {
    eventName: args.eventName,
    distinctId: args.distinctId,
    properties: args.properties,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
    sentAt: undefined,
    lastError: undefined,
  });
}

export async function writeAuditLog(
  ctx: MutationCtx,
  args: {
    entityType: string;
    entityId: string;
    action: string;
    actorType: 'admin' | 'system' | 'respondent';
    actorId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await ctx.db.insert('auditLogs', {
    entityType: args.entityType,
    entityId: args.entityId,
    action: args.action,
    actorType: args.actorType,
    actorId: args.actorId,
    metadata: args.metadata,
    createdAt: Date.now(),
  });
}
