import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireAppUser } from './lib/auth';
import { enqueueAnalyticsEvent, writeAuditLog } from './lib/domain';
import { normalizeSlug, assertUniqueFieldIds } from './lib/utils';
import { surveyFieldValidator, surveySettingsValidator, surveyStatusValidator } from './lib/validators';
import { parseSurveyFieldsWithZod } from './lib/zod';
import type { Doc } from './_generated/dataModel';

function assertSurveyOwnerOrAdmin(actor: Doc<'appUsers'>, survey: Doc<'surveys'>) {
  const allowed = actor.role === 'admin' || survey.createdByUserId === actor._id;
  if (!allowed) {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'You can only manage surveys you created.',
    });
  }
}

export const createSurvey = mutation({
  args: {
    title: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.object({ surveyId: v.id('surveys') }),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const now = Date.now();
    const slug = normalizeSlug(args.slug);

    if (!slug) {
      throw new ConvexError({ code: 'INVALID_SLUG', message: 'Slug is required.' });
    }

    const existing = await ctx.db
      .query('surveys')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();

    if (existing) {
      throw new ConvexError({ code: 'SLUG_TAKEN', message: 'Slug already exists.' });
    }

    const surveyId = await ctx.db.insert('surveys', {
      slug,
      title: args.title,
      description: args.description,
      status: 'draft',
      currentVersionId: undefined,
      createdByUserId: user._id,
      updatedByUserId: user._id,
      createdAt: now,
      updatedAt: now,
    });

    await writeAuditLog(ctx, {
      entityType: 'survey',
      entityId: surveyId,
      action: 'survey_created',
      actorType: 'admin',
      actorId: user._id,
      metadata: { slug, title: args.title },
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_created',
      distinctId: user.workosUserId,
      properties: {
        surveyId,
        slug,
      },
    });

    return { surveyId };
  },
});

export const updateSurvey = mutation({
  args: {
    surveyId: v.id('surveys'),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(surveyStatusValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey not found.' });
    }
    assertSurveyOwnerOrAdmin(user, survey);

    await ctx.db.patch(survey._id, {
      title: args.title ?? survey.title,
      description: args.description ?? survey.description,
      status: args.status ?? survey.status,
      updatedByUserId: user._id,
      updatedAt: Date.now(),
    });

    await writeAuditLog(ctx, {
      entityType: 'survey',
      entityId: survey._id,
      action: 'survey_updated',
      actorType: 'admin',
      actorId: user._id,
      metadata: { title: args.title, status: args.status },
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_updated',
      distinctId: user.workosUserId,
      properties: {
        surveyId: survey._id,
      },
    });

    return null;
  },
});

export const createVersionDraft = mutation({
  args: {
    surveyId: v.id('surveys'),
    fields: v.array(surveyFieldValidator),
    settings: surveySettingsValidator,
  },
  returns: v.object({
    surveyVersionId: v.id('surveyVersions'),
    version: v.number(),
  }),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);
    const survey = await ctx.db.get(args.surveyId);

    if (!survey) {
      throw new ConvexError({ code: 'NOT_FOUND', message: 'Survey not found.' });
    }
    assertSurveyOwnerOrAdmin(user, survey);

    let ordered = [...args.fields].sort((a, b) => a.order - b.order);

    try {
      ordered = parseSurveyFieldsWithZod(ordered);
      assertUniqueFieldIds(ordered);
    } catch (error) {
      throw new ConvexError({
        code: 'INVALID_FIELDS',
        message: error instanceof Error ? error.message : 'Invalid survey fields.',
      });
    }

    const latestVersion = await ctx.db
      .query('surveyVersions')
      .withIndex('by_survey_id', (q) => q.eq('surveyId', survey._id))
      .order('desc')
      .first();

    const version = latestVersion ? latestVersion.version + 1 : 1;
    const now = Date.now();

    const surveyVersionId = await ctx.db.insert('surveyVersions', {
      surveyId: survey._id,
      version,
      fields: ordered,
      settings: args.settings,
      createdByUserId: user._id,
      createdAt: now,
      publishedAt: undefined,
    });

    await ctx.db.patch(survey._id, {
      status: 'draft',
      updatedByUserId: user._id,
      updatedAt: now,
    });

    await writeAuditLog(ctx, {
      entityType: 'surveyVersion',
      entityId: surveyVersionId,
      action: 'survey_version_created',
      actorType: 'admin',
      actorId: user._id,
      metadata: { surveyId: survey._id, version },
    });

    return { surveyVersionId, version };
  },
});

export const publishVersion = mutation({
  args: {
    surveyId: v.id('surveys'),
    surveyVersionId: v.id('surveyVersions'),
  },
  returns: v.null(),
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

    const now = Date.now();

    await ctx.db.patch(args.surveyVersionId, {
      publishedAt: now,
    });

    await ctx.db.patch(args.surveyId, {
      currentVersionId: args.surveyVersionId,
      status: 'published',
      updatedByUserId: user._id,
      updatedAt: now,
    });

    await writeAuditLog(ctx, {
      entityType: 'surveyVersion',
      entityId: args.surveyVersionId,
      action: 'survey_published',
      actorType: 'admin',
      actorId: user._id,
      metadata: { surveyId: args.surveyId },
    });

    await enqueueAnalyticsEvent(ctx, {
      eventName: 'survey_published',
      distinctId: user.workosUserId,
      properties: {
        surveyId: args.surveyId,
        surveyVersionId: args.surveyVersionId,
      },
    });

    return null;
  },
});

export const listSurveys = query({
  args: {
    status: v.optional(surveyStatusValidator),
    search: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      surveyId: v.id('surveys'),
      slug: v.string(),
      title: v.string(),
      description: v.optional(v.string()),
      status: surveyStatusValidator,
      currentVersionId: v.optional(v.id('surveyVersions')),
      updatedAt: v.number(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);

    const search = args.search?.trim().toLowerCase();

    const rows = args.status
      ? await ctx.db
          .query('surveys')
          .withIndex('by_status', (q) => q.eq('status', args.status as 'draft' | 'published' | 'archived'))
          .order('desc')
          .collect()
      : await ctx.db.query('surveys').withIndex('by_updated_at').order('desc').collect();

    return rows
      .filter((row) => user.role === 'admin' || row.createdByUserId === user._id)
      .filter((row) => {
        if (!search) {
          return true;
        }
        return row.title.toLowerCase().includes(search) || row.slug.toLowerCase().includes(search);
      })
      .map((row) => ({
        surveyId: row._id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        status: row.status,
        currentVersionId: row.currentVersionId,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
      }));
  },
});

export const getSurveyDetail = query({
  args: { surveyId: v.id('surveys') },
  returns: v.union(
    v.object({
      surveyId: v.id('surveys'),
      slug: v.string(),
      title: v.string(),
      description: v.optional(v.string()),
      status: surveyStatusValidator,
      currentVersionId: v.optional(v.id('surveyVersions')),
      versions: v.array(
        v.object({
          surveyVersionId: v.id('surveyVersions'),
          version: v.number(),
          publishedAt: v.optional(v.number()),
          createdAt: v.number(),
          fieldCount: v.number(),
        }),
      ),
      currentVersion: v.union(
        v.object({
          surveyVersionId: v.id('surveyVersions'),
          version: v.number(),
          fields: v.array(surveyFieldValidator),
          settings: surveySettingsValidator,
        }),
        v.null(),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const user = await requireAppUser(ctx);

    const survey = await ctx.db.get(args.surveyId);
    if (!survey) {
      return null;
    }
    assertSurveyOwnerOrAdmin(user, survey);

    const versions = await ctx.db
      .query('surveyVersions')
      .withIndex('by_survey_id', (q) => q.eq('surveyId', survey._id))
      .order('desc')
      .collect();

    const currentVersion = survey.currentVersionId ? await ctx.db.get(survey.currentVersionId) : null;

    return {
      surveyId: survey._id,
      slug: survey.slug,
      title: survey.title,
      description: survey.description,
      status: survey.status,
      currentVersionId: survey.currentVersionId,
      versions: versions.map((version) => ({
        surveyVersionId: version._id,
        version: version.version,
        publishedAt: version.publishedAt,
        createdAt: version.createdAt,
        fieldCount: version.fields.length,
      })),
      currentVersion: currentVersion
        ? {
            surveyVersionId: currentVersion._id,
            version: currentVersion.version,
            fields: currentVersion.fields,
            settings: currentVersion.settings,
          }
        : null,
    };
  },
});
