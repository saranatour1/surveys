import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { bumpDailyMetric, enqueueAnalyticsEvent, writeAuditLog, writeTransition } from './lib/domain';
import { gradeSubmission } from './lib/scoring';
import {
  calculateProgress,
  getFieldMap,
  getInviteByToken,
  isAnswerPresent,
  isInviteUsable,
  validateAnswerForField,
} from './lib/utils';
import { answerValueValidator, answersValidator, sessionStatusValidator, surveyFieldValidator } from './lib/validators';
import { parseAnswerMapWithZod } from './lib/zod';
import type { Doc } from './_generated/dataModel';

const inviteStateValidator = v.union(
  v.literal('active'),
  v.literal('invalid'),
  v.literal('revoked'),
  v.literal('expired'),
  v.literal('exhausted'),
);

type InviteState = 'active' | 'invalid' | 'revoked' | 'expired' | 'exhausted';
type SessionStatus = 'in_progress' | 'idle' | 'abandoned' | 'completed';

function inviteStateFromInvite(invite: {
  status: 'active' | 'revoked' | 'exhausted' | 'expired';
  completionCount: number;
  maxCompletions: number;
  expiresAt?: number;
} | null): 'active' | 'invalid' | 'revoked' | 'expired' | 'exhausted' {
  if (!invite) return 'invalid';
  const now = Date.now();

  if (invite.status === 'revoked') {
    return 'revoked';
  }

  if (invite.status === 'expired') {
    return 'expired';
  }

  if (invite.expiresAt !== undefined && invite.expiresAt < now) {
    return 'expired';
  }

  if (invite.status === 'exhausted' || invite.completionCount >= invite.maxCompletions) {
    return 'exhausted';
  }

  return 'active';
}

export const resolveInvite = query({
  args: {
    inviteToken: v.string(),
  },
  returns: v.object({
    inviteState: inviteStateValidator,
    survey: v.union(
      v.object({
        surveyId: v.id('surveys'),
        title: v.string(),
        description: v.optional(v.string()),
        slug: v.string(),
      }),
      v.null(),
    ),
    version: v.union(
      v.object({
        surveyVersionId: v.id('surveyVersions'),
        version: v.number(),
        fields: v.array(surveyFieldValidator),
        settings: v.any(),
      }),
      v.null(),
    ),
    invite: v.union(
      v.object({
        inviteId: v.id('surveyInvites'),
        completionCount: v.number(),
        maxCompletions: v.number(),
        expiresAt: v.optional(v.number()),
      }),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    const invite = await getInviteByToken(ctx, args.inviteToken);

    if (!invite) {
      return {
        inviteState: 'invalid' as InviteState,
        survey: null,
        version: null,
        invite: null,
      };
    }

    const survey = await ctx.db.get(invite.surveyId);
    const version = await ctx.db.get(invite.surveyVersionId);

    if (!survey || !version) {
      return {
        inviteState: 'invalid' as InviteState,
        survey: null,
        version: null,
        invite: null,
      };
    }

    return {
      inviteState: inviteStateFromInvite(invite),
      survey: {
        surveyId: survey._id,
        title: survey.title,
        description: survey.description,
        slug: survey.slug,
      },
      version: {
        surveyVersionId: version._id,
        version: version.version,
        fields: version.fields,
        settings: version.settings,
      },
      invite: {
        inviteId: invite._id,
        completionCount: invite.completionCount,
        maxCompletions: invite.maxCompletions,
        expiresAt: invite.expiresAt,
      },
    };
  },
});

export const startOrResumeSession = mutation({
  args: {
    inviteToken: v.string(),
    respondentKey: v.string(),
    priorSessionId: v.optional(v.string()),
  },
  returns: v.object({
    sessionPublicId: v.string(),
    status: sessionStatusValidator,
    progress: v.object({
      progressPercent: v.number(),
      answeredCount: v.number(),
      requiredAnsweredCount: v.number(),
      requiredCount: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    if (args.respondentKey.length < 12 || args.respondentKey.length > 256) {
      throw new ConvexError({ code: 'INVALID_RESPONDENT_KEY', message: 'Invalid respondent key.' });
    }

    const now = Date.now();
    const invite = await getInviteByToken(ctx, args.inviteToken);

    if (!invite) {
      throw new ConvexError({ code: 'INVALID_INVITE', message: 'Invite token not found.' });
    }

    if (invite.status === 'active' && invite.expiresAt !== undefined && invite.expiresAt < now) {
      await ctx.db.patch(invite._id, { status: 'expired' });
      throw new ConvexError({ code: 'INVITE_EXPIRED', message: 'Invite has expired.' });
    }

    if (invite.status === 'active' && invite.completionCount >= invite.maxCompletions) {
      await ctx.db.patch(invite._id, { status: 'exhausted' });
      await enqueueAnalyticsEvent(ctx, {
        eventName: 'survey_invite_exhausted',
        distinctId: `invite:${invite._id}`,
        properties: {
          inviteId: invite._id,
          surveyId: invite.surveyId,
        },
      });
    }

    if (!isInviteUsable(invite, now)) {
      throw new ConvexError({ code: 'INVITE_UNAVAILABLE', message: 'Invite is not available.' });
    }

    const version = await ctx.db.get(invite.surveyVersionId);
    if (!version) {
      throw new ConvexError({ code: 'INVALID_INVITE', message: 'Invite version missing.' });
    }

    let candidate: Doc<'surveySessions'> | null = null;

    if (args.priorSessionId) {
      const prior = await ctx.db
        .query('surveySessions')
        .withIndex('by_session_public_id', (q) => q.eq('sessionPublicId', args.priorSessionId as string))
        .unique();
      if (
        prior &&
        prior.inviteId === invite._id &&
        prior.respondentKey === args.respondentKey &&
        prior.status !== 'completed'
      ) {
        candidate = prior;
      }
    }

    if (!candidate) {
      const byInvite = await ctx.db
        .query('surveySessions')
        .withIndex('by_invite_id', (q) => q.eq('inviteId', invite._id))
        .collect();

      candidate = byInvite.find((session) => session.respondentKey === args.respondentKey && session.status !== 'completed') ?? null;
    }

    if (candidate) {
      const fromStatus = candidate.status;
      let toStatus: SessionStatus = fromStatus;

      if (candidate.status === 'idle' || candidate.status === 'abandoned') {
        toStatus = 'in_progress';
      }

      await ctx.db.patch(candidate._id, {
        status: toStatus,
        lastActivityAt: now,
      });

      if (fromStatus !== toStatus) {
        await writeTransition(ctx, {
          sessionId: candidate._id,
          surveyId: candidate.surveyId,
          fromStatus,
          toStatus,
          reason: 'resumed',
          at: now,
        });

        await bumpDailyMetric(ctx, {
          surveyId: candidate.surveyId,
          metric: 'reactivated',
          timestamp: now,
        });
      }

      await enqueueAnalyticsEvent(ctx, {
        eventName: fromStatus === 'in_progress' ? 'survey_session_resumed' : 'survey_session_reactivated',
        distinctId: candidate.sessionPublicId,
        properties: {
          surveyId: candidate.surveyId,
          sessionPublicId: candidate.sessionPublicId,
          inviteId: invite._id,
          statusFrom: fromStatus,
          statusTo: toStatus,
        },
      });

      const progress = calculateProgress(version.fields, candidate.answersDraft);

      return {
        sessionPublicId: candidate.sessionPublicId,
        status: toStatus,
        progress,
      };
    }

    const sessionPublicId = crypto.randomUUID();

    const sessionId = await ctx.db.insert('surveySessions', {
      sessionPublicId,
      surveyId: invite.surveyId,
      surveyVersionId: invite.surveyVersionId,
      inviteId: invite._id,
      respondentKey: args.respondentKey,
      status: 'in_progress',
      startedAt: now,
      lastActivityAt: now,
      completedAt: undefined,
      answersDraft: {},
    });

    await writeTransition(ctx, {
      sessionId,
      surveyId: invite.surveyId,
      fromStatus: undefined,
      toStatus: 'in_progress',
      reason: 'started',
      at: now,
    });

    await bumpDailyMetric(ctx, {
      surveyId: invite.surveyId,
      metric: 'started',
      timestamp: now,
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_session_started',
      distinctId: sessionPublicId,
      properties: {
        surveyId: invite.surveyId,
        surveyVersionId: invite.surveyVersionId,
        inviteId: invite._id,
        sessionPublicId,
      },
    });

    await writeAuditLog(ctx, {
      entityType: 'surveySession',
      entityId: sessionId,
      action: 'survey_session_started',
      actorType: 'respondent',
      actorId: args.respondentKey,
      metadata: {
        surveyId: invite.surveyId,
        inviteId: invite._id,
      },
    });

    return {
      sessionPublicId,
      status: 'in_progress' as SessionStatus,
      progress: {
        progressPercent: 0,
        answeredCount: 0,
        requiredAnsweredCount: 0,
        requiredCount: version.fields.filter((field) => field.required).length,
      },
    };
  },
});

export const saveAnswer = mutation({
  args: {
    sessionPublicId: v.string(),
    fieldId: v.string(),
    value: answerValueValidator,
  },
  returns: v.object({
    progressPercent: v.number(),
    status: sessionStatusValidator,
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const session = await ctx.db
      .query('surveySessions')
      .withIndex('by_session_public_id', (q) => q.eq('sessionPublicId', args.sessionPublicId))
      .unique();

    if (!session) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Session not found.' });
    }

    if (session.status === 'completed') {
      throw new ConvexError({ code: 'SESSION_COMPLETED', message: 'Session already completed.' });
    }

    const version = await ctx.db.get(session.surveyVersionId);
    if (!version) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey version not found.' });
    }

    const fieldMap = getFieldMap(version);
    const field = fieldMap.get(args.fieldId);
    if (!field) {
      throw new ConvexError({ code: 'INVALID_FIELD', message: `Field ${args.fieldId} does not exist.` });
    }

    validateAnswerForField(field, args.value);

    const nextAnswers = {
      ...session.answersDraft,
      [args.fieldId]: args.value,
    };

    parseAnswerMapWithZod(nextAnswers);

    let nextStatus = session.status;

    if (session.status === 'idle' || session.status === 'abandoned') {
      nextStatus = 'in_progress';
      await writeTransition(ctx, {
        sessionId: session._id,
        surveyId: session.surveyId,
        fromStatus: session.status,
        toStatus: 'in_progress',
        reason: 'answer_saved_reactivated',
        at: now,
      });
      await bumpDailyMetric(ctx, {
        surveyId: session.surveyId,
        metric: 'reactivated',
        timestamp: now,
      });
    }

    await ctx.db.patch(session._id, {
      answersDraft: nextAnswers,
      status: nextStatus,
      lastActivityAt: now,
    });

    const progress = calculateProgress(version.fields, nextAnswers);

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_answer_saved',
      distinctId: session.sessionPublicId,
      properties: {
        surveyId: session.surveyId,
        inviteId: session.inviteId,
        sessionPublicId: session.sessionPublicId,
        fieldId: args.fieldId,
        status: nextStatus,
        progressPercent: progress.progressPercent,
        answeredCount: progress.answeredCount,
        questionCount: version.fields.length,
      },
    });

    return {
      progressPercent: progress.progressPercent,
      status: nextStatus,
    };
  },
});

export const submitSession = mutation({
  args: {
    sessionPublicId: v.string(),
  },
  returns: v.object({
    responseId: v.id('surveyResponses'),
    completedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const session = await ctx.db
      .query('surveySessions')
      .withIndex('by_session_public_id', (q) => q.eq('sessionPublicId', args.sessionPublicId))
      .unique();

    if (!session) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Session not found.' });
    }

    if (session.status === 'completed') {
      throw new ConvexError({ code: 'SESSION_COMPLETED', message: 'Session already completed.' });
    }

    const invite = await ctx.db.get(session.inviteId);
    if (!invite) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Invite not found.' });
    }

    if (invite.status === 'active' && invite.expiresAt !== undefined && invite.expiresAt < now) {
      await ctx.db.patch(invite._id, { status: 'expired' });
      throw new ConvexError({ code: 'INVITE_EXPIRED', message: 'Invite expired.' });
    }

    if (invite.completionCount >= invite.maxCompletions) {
      await ctx.db.patch(invite._id, { status: 'exhausted' });
      throw new ConvexError({ code: 'INVITE_EXHAUSTED', message: 'Invite has no completions remaining.' });
    }

    if (invite.status !== 'active') {
      throw new ConvexError({ code: 'INVITE_UNAVAILABLE', message: 'Invite is not active.' });
    }

    const version = await ctx.db.get(session.surveyVersionId);
    if (!version) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey version not found.' });
    }

    parseAnswerMapWithZod(session.answersDraft);

    for (const field of version.fields) {
      const value = session.answersDraft[field.id];
      validateAnswerForField(field, value);
      if (field.required && !isAnswerPresent(value)) {
        throw new ConvexError({
          code: 'MISSING_REQUIRED_FIELD',
          message: `Field ${field.id} is required.`,
        });
      }
    }

    const grading = gradeSubmission(version.fields, session.answersDraft);

    const responseId = await ctx.db.insert('surveyResponses', {
      sessionId: session._id,
      sessionPublicId: session.sessionPublicId,
      surveyId: session.surveyId,
      surveyVersionId: session.surveyVersionId,
      inviteId: session.inviteId,
      submittedAt: now,
      answers: session.answersDraft,
      durationMs: now - session.startedAt,
      grading,
    });

    await ctx.db.patch(session._id, {
      status: 'completed',
      completedAt: now,
      lastActivityAt: now,
    });

    await writeTransition(ctx, {
      sessionId: session._id,
      surveyId: session.surveyId,
      fromStatus: session.status,
      toStatus: 'completed',
      reason: 'submitted',
      at: now,
    });

    await bumpDailyMetric(ctx, {
      surveyId: session.surveyId,
      metric: 'completed',
      timestamp: now,
    });

    const nextCompletionCount = invite.completionCount + 1;
    const inviteNowExhausted = nextCompletionCount >= invite.maxCompletions;

    await ctx.db.patch(invite._id, {
      completionCount: nextCompletionCount,
      status: inviteNowExhausted ? 'exhausted' : invite.status,
    });

    if (inviteNowExhausted) {
      await enqueueAnalyticsEvent(ctx, {
        eventName: 'survey_invite_exhausted',
        distinctId: session.sessionPublicId,
        properties: {
          surveyId: session.surveyId,
          inviteId: invite._id,
        },
      });
    }

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_submitted',
      distinctId: session.sessionPublicId,
      properties: {
        surveyId: session.surveyId,
        surveyVersionId: session.surveyVersionId,
        inviteId: session.inviteId,
        sessionPublicId: session.sessionPublicId,
        durationMs: now - session.startedAt,
        isLateCompletion: session.status === 'idle' || session.status === 'abandoned',
      },
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_submission_graded',
      distinctId: session.sessionPublicId,
      properties: {
        surveyId: session.surveyId,
        surveyVersionId: session.surveyVersionId,
        sessionPublicId: session.sessionPublicId,
        gradableCount: grading.gradableCount,
        correctCount: grading.correctCount,
        scorePercent: grading.scorePercent,
      },
    });

    await writeAuditLog(ctx, {
      entityType: 'surveyResponse',
      entityId: responseId,
      action: 'survey_submitted',
      actorType: 'respondent',
      actorId: session.respondentKey,
      metadata: {
        surveyId: session.surveyId,
        inviteId: session.inviteId,
      },
    });

    return {
      responseId,
      completedAt: now,
    };
  },
});

export const getSessionSnapshot = query({
  args: {
    sessionPublicId: v.string(),
  },
  returns: v.union(
    v.object({
      sessionPublicId: v.string(),
      status: sessionStatusValidator,
      surveyId: v.id('surveys'),
      surveyVersionId: v.id('surveyVersions'),
      answersDraft: answersValidator,
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
      sessionPublicId: session.sessionPublicId,
      status: session.status,
      surveyId: session.surveyId,
      surveyVersionId: session.surveyVersionId,
      answersDraft: session.answersDraft,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      completedAt: session.completedAt,
    };
  },
});
