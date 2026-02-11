import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireAppUser } from './lib/auth';
import { DEFAULT_INVITE_TTL_MS } from './lib/constants';
import { enqueueAnalyticsEvent, writeAuditLog } from './lib/domain';
import { hashToken, randomInviteToken } from './lib/utils';
import type { Doc } from './_generated/dataModel';

function assertSurveyOwnerOrAdmin(actor: Doc<'appUsers'>, survey: Doc<'surveys'>) {
  const allowed = actor.role === 'admin' || survey.createdByUserId === actor._id;
  if (!allowed) {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'You can only manage invites for surveys you created.',
    });
  }
}

export const createInvite = mutation({
  args: {
    surveyId: v.id('surveys'),
    surveyVersionId: v.id('surveyVersions'),
    expiresAt: v.optional(v.number()),
    maxCompletions: v.optional(v.number()),
  },
  returns: v.object({
    inviteId: v.id('surveyInvites'),
    inviteToken: v.string(),
  }),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey not found.' });
    }
    assertSurveyOwnerOrAdmin(user, survey);

    const version = await ctx.db.get(args.surveyVersionId);
    if (!version || version.surveyId !== survey._id) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey version not found.' });
    }

    const inviteToken = randomInviteToken();
    const tokenHash = await hashToken(inviteToken);

    const maxCompletions = Math.max(1, args.maxCompletions ?? 1);
    const now = Date.now();
    const expiresAt = args.expiresAt ?? now + DEFAULT_INVITE_TTL_MS;

    const inviteId = await ctx.db.insert('surveyInvites', {
      surveyId: survey._id,
      surveyVersionId: version._id,
      tokenHash,
      status: 'active',
      maxCompletions,
      completionCount: 0,
      expiresAt,
      createdByUserId: user._id,
      createdAt: now,
      revokedAt: undefined,
    });

    await writeAuditLog(ctx, {
      entityType: 'surveyInvite',
      entityId: inviteId,
      action: 'survey_invite_created',
      actorType: 'admin',
      actorId: user._id,
      metadata: {
        surveyId: survey._id,
        surveyVersionId: version._id,
        maxCompletions,
        expiresAt,
      },
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_invite_created',
      distinctId: user.workosUserId,
      properties: {
        surveyId: survey._id,
        surveyVersionId: version._id,
        inviteId,
      },
    });

    return {
      inviteId,
      inviteToken,
    };
  },
});

export const revokeInvite = mutation({
  args: {
    inviteId: v.id('surveyInvites'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Invite not found.' });
    }
    const survey = await ctx.db.get(invite.surveyId);
    if (!survey) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey not found.' });
    }
    assertSurveyOwnerOrAdmin(user, survey);

    await ctx.db.patch(invite._id, {
      status: 'revoked',
      revokedAt: Date.now(),
    });

    await writeAuditLog(ctx, {
      entityType: 'surveyInvite',
      entityId: invite._id,
      action: 'survey_invite_revoked',
      actorType: 'admin',
      actorId: user._id,
      metadata: {
        surveyId: invite.surveyId,
      },
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_invite_revoked',
      distinctId: user.workosUserId,
      properties: {
        surveyId: invite.surveyId,
        inviteId: invite._id,
      },
    });

    return null;
  },
});

export const listInvitesForSurvey = query({
  args: {
    surveyId: v.id('surveys'),
  },
  returns: v.array(
    v.object({
      inviteId: v.id('surveyInvites'),
      status: v.union(v.literal('active'), v.literal('revoked'), v.literal('exhausted'), v.literal('expired')),
      completionCount: v.number(),
      maxCompletions: v.number(),
      expiresAt: v.optional(v.number()),
      createdAt: v.number(),
      surveyVersionId: v.id('surveyVersions'),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      return [];
    }
    assertSurveyOwnerOrAdmin(user, survey);

    const invites = await ctx.db
      .query('surveyInvites')
      .withIndex('by_survey_id', (q) => q.eq('surveyId', args.surveyId))
      .order('desc')
      .collect();

    return invites.map((invite) => ({
      inviteId: invite._id,
      status: invite.status,
      completionCount: invite.completionCount,
      maxCompletions: invite.maxCompletions,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      surveyVersionId: invite.surveyVersionId,
    }));
  },
});
