import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { ABANDONED_THRESHOLD_MS, IDLE_THRESHOLD_MS } from './lib/constants';
import { bumpDailyMetric, enqueueAnalyticsEvent, writeTransition } from './lib/domain';
import { sessionStatusValidator } from './lib/validators';

const batchLimitValidator = v.optional(v.number());

async function transitionSession(
  ctx: MutationCtx,
  args: {
    sessionId: Id<'surveySessions'>;
    toStatus: 'in_progress' | 'idle' | 'abandoned' | 'completed';
    reason: string;
    at: number;
  },
) {
  const session = await ctx.db.get(args.sessionId);
  if (!session) {
    return false;
  }

  if (session.status === args.toStatus) {
    return false;
  }

  const fromStatus = session.status;

  await ctx.db.patch(session._id, {
    status: args.toStatus,
    lastActivityAt: args.at,
    completedAt: args.toStatus === 'completed' ? args.at : session.completedAt,
  });

  await writeTransition(ctx, {
    sessionId: session._id,
    surveyId: session.surveyId,
    fromStatus,
    toStatus: args.toStatus,
    reason: args.reason,
    at: args.at,
  });

  if (args.toStatus === 'idle') {
    await bumpDailyMetric(ctx, { surveyId: session.surveyId, metric: 'idle', timestamp: args.at });
  }
  if (args.toStatus === 'abandoned') {
    await bumpDailyMetric(ctx, { surveyId: session.surveyId, metric: 'abandoned', timestamp: args.at });
  }
  if (args.toStatus === 'in_progress' && (fromStatus === 'idle' || fromStatus === 'abandoned')) {
    await bumpDailyMetric(ctx, { surveyId: session.surveyId, metric: 'reactivated', timestamp: args.at });
  }
  if (args.toStatus === 'completed') {
    await bumpDailyMetric(ctx, { surveyId: session.surveyId, metric: 'completed', timestamp: args.at });
  }

  const eventName =
    args.toStatus === 'idle'
      ? 'survey_session_idle'
      : args.toStatus === 'abandoned'
        ? 'survey_session_abandoned'
        : args.toStatus === 'in_progress'
          ? 'survey_session_reactivated'
          : 'survey_submitted';

  await enqueueAnalyticsEvent(ctx, {
    eventName,
    distinctId: session.sessionPublicId,
    properties: {
      surveyId: session.surveyId,
      inviteId: session.inviteId,
      sessionPublicId: session.sessionPublicId,
      statusFrom: fromStatus,
      statusTo: args.toStatus,
      reason: args.reason,
      idleMinutes: Math.floor((args.at - session.lastActivityAt) / 60000),
    },
  });

  return true;
}

export const transitionState = internalMutation({
  args: {
    sessionId: v.id('surveySessions'),
    toStatus: sessionStatusValidator,
    reason: v.string(),
  },
  returns: v.object({ transitioned: v.boolean() }),
  handler: async (ctx, args) => {
    const transitioned = await transitionSession(ctx, {
      sessionId: args.sessionId,
      toStatus: args.toStatus,
      reason: args.reason,
      at: Date.now(),
    });
    return { transitioned };
  },
});

export const markIdleBatch = internalMutation({
  args: {
    limit: batchLimitValidator,
  },
  returns: v.object({ processed: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = now - IDLE_THRESHOLD_MS;
    const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));

    const sessions = await ctx.db
      .query('surveySessions')
      .withIndex('by_status_and_last_activity', (q) => q.eq('status', 'in_progress').lt('lastActivityAt', cutoff))
      .take(limit);

    let processed = 0;
    for (const session of sessions) {
      const transitioned = await transitionSession(ctx, {
        sessionId: session._id,
        toStatus: 'idle',
        reason: 'idle_timeout',
        at: now,
      });
      if (transitioned) {
        processed += 1;
      }
    }

    return { processed };
  },
});

export const markAbandonedBatch = internalMutation({
  args: {
    limit: batchLimitValidator,
  },
  returns: v.object({ processed: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = now - ABANDONED_THRESHOLD_MS;
    const limit = Math.max(1, Math.min(args.limit ?? 200, 1000));

    const idleSessions = await ctx.db
      .query('surveySessions')
      .withIndex('by_status_and_last_activity', (q) => q.eq('status', 'idle').lt('lastActivityAt', cutoff))
      .take(limit);

    const remaining = Math.max(limit - idleSessions.length, 0);
    const inProgressSessions =
      remaining > 0
        ? await ctx.db
            .query('surveySessions')
            .withIndex('by_status_and_last_activity', (q) => q.eq('status', 'in_progress').lt('lastActivityAt', cutoff))
            .take(remaining)
        : [];

    let processed = 0;
    for (const session of [...idleSessions, ...inProgressSessions]) {
      const transitioned = await transitionSession(ctx, {
        sessionId: session._id,
        toStatus: 'abandoned',
        reason: 'abandoned_timeout',
        at: now,
      });
      if (transitioned) {
        processed += 1;
      }
    }

    return { processed };
  },
});

export const getSessionByPublicId = query({
  args: {
    sessionPublicId: v.string(),
  },
  returns: v.union(
    v.object({
      sessionId: v.id('surveySessions'),
      status: sessionStatusValidator,
      surveyId: v.id('surveys'),
      inviteId: v.id('surveyInvites'),
      startedAt: v.number(),
      lastActivityAt: v.number(),
      completedAt: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('surveySessions')
      .withIndex('by_session_public_id', (q) => q.eq('sessionPublicId', args.sessionPublicId))
      .unique();

    if (!session) {
      return null;
    }

    return {
      sessionId: session._id,
      status: session.status,
      surveyId: session.surveyId,
      inviteId: session.inviteId,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      completedAt: session.completedAt,
    };
  },
});
