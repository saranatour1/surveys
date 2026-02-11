import { DateTime } from 'luxon';
import { internalMutation, mutation } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { requireAppUser } from './lib/auth';
import { rebuildDailyMaterializedAnalytics } from './lib/analytics_materialization';
import { bumpDailyMetric, writeTransition } from './lib/domain';
import { gradeSubmission } from './lib/scoring';
import { hashToken, randomInviteToken } from './lib/utils';
import { appUserRoleValidator } from './lib/validators';
import { v } from 'convex/values';

type SurveyField = Doc<'surveyVersions'>['fields'][number];
type AnswerValue = string | number | boolean | string[] | null;

type SeedCounts = {
  completed: number;
  idle: number;
  abandoned: number;
  inProgress: number;
};

const seedArgsValidator = {
  surveyCount: v.optional(v.number()),
  sessionsPerSurvey: v.optional(v.number()),
};

const seedSurveyResultValidator = v.object({
  surveyId: v.id('surveys'),
  slug: v.string(),
  title: v.string(),
  inviteToken: v.string(),
  startedCount: v.number(),
  completedCount: v.number(),
  idleCount: v.number(),
  abandonedCount: v.number(),
  inProgressCount: v.number(),
});

const seedResultValidator = v.object({
  owner: v.object({
    appUserId: v.id('appUsers'),
    email: v.string(),
    role: appUserRoleValidator,
  }),
  createdSurveyCount: v.number(),
  createdSessionCount: v.number(),
  createdResponseCount: v.number(),
  surveys: v.array(seedSurveyResultValidator),
  seededAt: v.number(),
});

const TEST_TEXT_POOL = [
  'checkout flow is smooth but loading can be faster',
  'love the analytics dashboard and weekly trend visibility',
  'onboarding was clear and the invite flow worked quickly',
  'mobile layout is usable but some labels are too dense',
  'report export is useful for operations review meetings',
  'survey builder is compact and easier than drag and drop',
  'need better notification preferences and reminder timing',
  'overall quality is strong and response speed is great',
  'table layout helps us review drop-off points quickly',
  'text insights are useful when snippets remain anonymized',
];

const NUMBER_OPTIONS = [
  [
    { label: 'Very Low', value: '1' },
    { label: 'Low', value: '2' },
    { label: 'Neutral', value: '3' },
    { label: 'High', value: '4' },
    { label: 'Very High', value: '5' },
  ],
];

const surveyBlueprints: Array<{
  key: string;
  title: string;
  description: string;
  settings: Doc<'surveyVersions'>['settings'];
  fields: SurveyField[];
}> = [
  {
    key: 'customer_satisfaction',
    title: 'Customer Satisfaction Pulse',
    description: 'Track satisfaction, recommendation intent, and key friction points.',
    settings: {
      title: 'Customer Satisfaction Pulse',
      description: 'Quick post-interaction pulse survey',
      showProgressBar: true,
    },
    fields: [
      {
        id: 'overall_rating',
        kind: 'rating_1_5',
        label: 'Overall, how satisfied are you?',
        required: true,
        order: 0,
        correctness: {
          mode: 'numeric_exact',
          expectedNumber: 5,
          tolerance: 0,
        },
      },
      {
        id: 'recommend_intent',
        kind: 'single_select',
        label: 'Would you recommend us?',
        required: true,
        order: 1,
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
        correctness: {
          mode: 'single_select_exact',
          expectedOptionValue: 'yes',
        },
      },
      {
        id: 'friction_points',
        kind: 'multi_select',
        label: 'Where did you experience friction?',
        required: false,
        order: 2,
        options: [
          { label: 'Checkout', value: 'checkout' },
          { label: 'Navigation', value: 'navigation' },
          { label: 'Performance', value: 'performance' },
          { label: 'Support', value: 'support' },
        ],
      },
      {
        id: 'feedback_detail',
        kind: 'long_text',
        label: 'Tell us more',
        required: false,
        order: 3,
        validation: { minLength: 10, maxLength: 500 },
      },
    ],
  },
  {
    key: 'feature_prioritization',
    title: 'Feature Prioritization Survey',
    description: 'Understand which areas users prioritize and what blocks adoption.',
    settings: {
      title: 'Feature Prioritization Survey',
      description: 'Prioritization input for roadmap planning',
      showProgressBar: true,
    },
    fields: [
      {
        id: 'top_feature',
        kind: 'single_select',
        label: 'Which capability matters most?',
        required: true,
        order: 0,
        options: [
          { label: 'Automation', value: 'automation' },
          { label: 'Analytics', value: 'analytics' },
          { label: 'Integrations', value: 'integrations' },
          { label: 'Collaboration', value: 'collaboration' },
        ],
      },
      {
        id: 'adoption_score',
        kind: 'number',
        label: 'How likely are you to expand usage (1-10)?',
        required: true,
        order: 1,
        validation: { min: 1, max: 10 },
        correctness: {
          mode: 'numeric_exact',
          expectedNumber: 10,
          tolerance: 1,
        },
      },
      {
        id: 'blockers',
        kind: 'multi_select',
        label: 'What is currently blocking wider adoption?',
        required: false,
        order: 2,
        options: [
          { label: 'Missing Features', value: 'missing_features' },
          { label: 'Pricing', value: 'pricing' },
          { label: 'Internal Approval', value: 'approval' },
          { label: 'Training', value: 'training' },
        ],
      },
      {
        id: 'why_top_feature',
        kind: 'short_text',
        label: 'Why did you choose that top feature?',
        required: false,
        order: 3,
        validation: { maxLength: 240 },
      },
    ],
  },
  {
    key: 'support_experience',
    title: 'Support Experience Review',
    description: 'Assess support response quality, timeliness, and resolution clarity.',
    settings: {
      title: 'Support Experience Review',
      description: 'Follow-up after support interaction',
      showProgressBar: true,
    },
    fields: [
      {
        id: 'resolution_quality',
        kind: 'rating_1_5',
        label: 'Rate the quality of the resolution',
        required: true,
        order: 0,
        correctness: {
          mode: 'numeric_exact',
          expectedNumber: 5,
          tolerance: 0,
        },
      },
      {
        id: 'response_speed',
        kind: 'single_select',
        label: 'How was response speed?',
        required: true,
        order: 1,
        options: [
          { label: 'Slow', value: 'slow' },
          { label: 'Acceptable', value: 'acceptable' },
          { label: 'Fast', value: 'fast' },
        ],
      },
      {
        id: 'contact_email',
        kind: 'email',
        label: 'Optional follow-up email',
        required: false,
        order: 2,
      },
      {
        id: 'notes',
        kind: 'long_text',
        label: 'Anything else we should improve?',
        required: false,
        order: 3,
        validation: { maxLength: 600 },
      },
    ],
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function countsForSessions(sessionCount: number): SeedCounts {
  const completed = Math.max(1, Math.floor(sessionCount * 0.58));
  const idle = Math.max(1, Math.floor(sessionCount * 0.16));
  const abandoned = Math.max(1, Math.floor(sessionCount * 0.12));
  const inProgress = Math.max(sessionCount - completed - idle - abandoned, 0);
  return { completed, idle, abandoned, inProgress };
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function uniqueSubset<T>(items: T[], maxPick: number): T[] {
  if (items.length === 0) {
    return [];
  }
  const copy = [...items];
  copy.sort(() => (Math.random() > 0.5 ? 1 : -1));
  const count = clamp(Math.floor(Math.random() * maxPick) + 1, 1, items.length);
  return copy.slice(0, count);
}

function sampleText(): string {
  return pick(TEST_TEXT_POOL);
}

function generateAnswerForField(field: SurveyField): AnswerValue {
  switch (field.kind) {
    case 'short_text':
    case 'long_text':
      return sampleText();
    case 'single_select':
      return pick((field.options ?? [{ label: 'Yes', value: 'yes' }]).map((option) => option.value));
    case 'multi_select':
      return uniqueSubset((field.options ?? []).map((option) => option.value), 2);
    case 'number': {
      const min = field.validation?.min ?? 1;
      const max = field.validation?.max ?? 10;
      return clamp(Math.floor(Math.random() * (max - min + 1)) + min, min, max);
    }
    case 'email':
      return `user${Math.floor(Math.random() * 200)}@example.test`;
    case 'date':
      return DateTime.utc().minus({ days: Math.floor(Math.random() * 30) }).toISODate() ?? '2025-01-01';
    case 'rating_1_5':
      return clamp(Math.floor(Math.random() * 5) + 1, 1, 5);
  }
}

function generateAnswers(fields: SurveyField[], partial = false): Record<string, AnswerValue> {
  const answers: Record<string, AnswerValue> = {};
  for (const field of fields) {
    if (partial && !field.required && Math.random() > 0.35) {
      continue;
    }
    answers[field.id] = generateAnswerForField(field);
  }
  return answers;
}

function sessionPublicId(prefix: string, surveyIndex: number, idx: number) {
  return `sess_${prefix}_${surveyIndex}_${idx}_${crypto.randomUUID().slice(0, 8)}`;
}

async function insertPublishedSurvey(ctx: MutationCtx, args: {
  ownerId: Id<'appUsers'>;
  blueprint: (typeof surveyBlueprints)[number];
  surveyIndex: number;
  now: number;
}) {
  const slug = `${args.blueprint.key}-${DateTime.fromMillis(args.now).toFormat('yyyyLLdd')}-${args.surveyIndex + 1}`;
  const surveyId = await ctx.db.insert('surveys', {
    slug,
    title: args.blueprint.title,
    description: args.blueprint.description,
    status: 'published',
    currentVersionId: undefined,
    createdByUserId: args.ownerId,
    updatedByUserId: args.ownerId,
    createdAt: args.now,
    updatedAt: args.now,
  });

  const versionId = await ctx.db.insert('surveyVersions', {
    surveyId,
    version: 1,
    fields: args.blueprint.fields,
    settings: args.blueprint.settings,
    createdByUserId: args.ownerId,
    createdAt: args.now,
    publishedAt: args.now,
  });

  await ctx.db.patch(surveyId, {
    currentVersionId: versionId,
    status: 'published',
    updatedAt: args.now,
    updatedByUserId: args.ownerId,
  });

  return {
    surveyId,
    versionId,
    slug,
  };
}

async function insertInvite(ctx: MutationCtx, args: {
  ownerId: Id<'appUsers'>;
  surveyId: Id<'surveys'>;
  versionId: Id<'surveyVersions'>;
  maxCompletions: number;
  now: number;
}) {
  const inviteToken = randomInviteToken();
  const tokenHash = await hashToken(inviteToken);
  const inviteId = await ctx.db.insert('surveyInvites', {
    surveyId: args.surveyId,
    surveyVersionId: args.versionId,
    tokenHash,
    status: 'active',
    maxCompletions: args.maxCompletions,
    completionCount: 0,
    expiresAt: DateTime.fromMillis(args.now).plus({ days: 45 }).toMillis(),
    createdByUserId: args.ownerId,
    createdAt: args.now,
    revokedAt: undefined,
  });
  return {
    inviteId,
    inviteToken,
  };
}

async function seedSurveyRuntime(ctx: MutationCtx, args: {
  ownerId: Id<'appUsers'>;
  surveyId: Id<'surveys'>;
  versionId: Id<'surveyVersions'>;
  inviteId: Id<'surveyInvites'>;
  fields: SurveyField[];
  counts: SeedCounts;
  surveyIndex: number;
  now: number;
}) {
  const responseDayKeys = new Set<string>();
  let createdSessions = 0;
  let createdResponses = 0;

  const allPlanned: Array<{ status: 'completed' | 'idle' | 'abandoned' | 'in_progress'; index: number }> = [];

  for (let i = 0; i < args.counts.completed; i += 1) {
    allPlanned.push({ status: 'completed', index: allPlanned.length });
  }
  for (let i = 0; i < args.counts.idle; i += 1) {
    allPlanned.push({ status: 'idle', index: allPlanned.length });
  }
  for (let i = 0; i < args.counts.abandoned; i += 1) {
    allPlanned.push({ status: 'abandoned', index: allPlanned.length });
  }
  for (let i = 0; i < args.counts.inProgress; i += 1) {
    allPlanned.push({ status: 'in_progress', index: allPlanned.length });
  }

  for (const entry of allPlanned) {
    const dayOffset = entry.index % 12;
    const startBase = DateTime.fromMillis(args.now)
      .minus({ days: dayOffset, hours: Math.floor(Math.random() * 20) + 1, minutes: Math.floor(Math.random() * 59) })
      .toMillis();

    const respondentKey = `seed_resp_${args.surveyIndex}_${entry.index}_${crypto.randomUUID().slice(0, 6)}`;
    const publicId = sessionPublicId('seed', args.surveyIndex, entry.index);

    let answersDraft = generateAnswers(args.fields, entry.status !== 'completed');
    let status: Doc<'surveySessions'>['status'] = entry.status;
    let lastActivityAt = startBase + Math.floor(Math.random() * 10 * 60 * 1000);
    let completedAt: number | undefined;

    if (entry.status === 'idle') {
      lastActivityAt = DateTime.fromMillis(args.now)
        .minus({ minutes: 20 + Math.floor(Math.random() * 15) })
        .toMillis();
    }

    if (entry.status === 'abandoned') {
      lastActivityAt = DateTime.fromMillis(args.now)
        .minus({ hours: 28 + Math.floor(Math.random() * 24) })
        .toMillis();
    }

    if (entry.status === 'in_progress') {
      lastActivityAt = DateTime.fromMillis(args.now)
        .minus({ minutes: 1 + Math.floor(Math.random() * 8) })
        .toMillis();
    }

    if (entry.status === 'completed') {
      answersDraft = generateAnswers(args.fields, false);
      completedAt = startBase + Math.floor(Math.random() * 18 * 60 * 1000) + 2 * 60 * 1000;
      lastActivityAt = completedAt;
      status = 'completed';
    }

    const sessionId = await ctx.db.insert('surveySessions', {
      sessionPublicId: publicId,
      surveyId: args.surveyId,
      surveyVersionId: args.versionId,
      inviteId: args.inviteId,
      respondentKey,
      status,
      startedAt: startBase,
      lastActivityAt,
      completedAt,
      answersDraft,
    });

    createdSessions += 1;

    await writeTransition(ctx, {
      sessionId,
      surveyId: args.surveyId,
      fromStatus: undefined,
      toStatus: 'in_progress',
      reason: 'seed_started',
      at: startBase,
    });

    await bumpDailyMetric(ctx, {
      surveyId: args.surveyId,
      metric: 'started',
      timestamp: startBase,
    });

    if (entry.status === 'completed' && completedAt !== undefined) {
      const grading = gradeSubmission(args.fields, answersDraft);
      await ctx.db.insert('surveyResponses', {
        sessionId,
        sessionPublicId: publicId,
        surveyId: args.surveyId,
        surveyVersionId: args.versionId,
        inviteId: args.inviteId,
        submittedAt: completedAt,
        answers: answersDraft,
        durationMs: completedAt - startBase,
        grading,
      });

      responseDayKeys.add(DateTime.fromMillis(completedAt, { zone: 'utc' }).toISODate() ?? '1970-01-01');
      createdResponses += 1;

      await writeTransition(ctx, {
        sessionId,
        surveyId: args.surveyId,
        fromStatus: 'in_progress',
        toStatus: 'completed',
        reason: 'seed_submitted',
        at: completedAt,
      });

      await bumpDailyMetric(ctx, {
        surveyId: args.surveyId,
        metric: 'completed',
        timestamp: completedAt,
      });
    }

    if (entry.status === 'idle') {
      await writeTransition(ctx, {
        sessionId,
        surveyId: args.surveyId,
        fromStatus: 'in_progress',
        toStatus: 'idle',
        reason: 'seed_idle',
        at: lastActivityAt,
      });

      await bumpDailyMetric(ctx, {
        surveyId: args.surveyId,
        metric: 'idle',
        timestamp: lastActivityAt,
      });
    }

    if (entry.status === 'abandoned') {
      await writeTransition(ctx, {
        sessionId,
        surveyId: args.surveyId,
        fromStatus: 'in_progress',
        toStatus: 'abandoned',
        reason: 'seed_abandoned',
        at: lastActivityAt,
      });

      await bumpDailyMetric(ctx, {
        surveyId: args.surveyId,
        metric: 'abandoned',
        timestamp: lastActivityAt,
      });
    }
  }

  for (const dateKey of responseDayKeys) {
    await rebuildDailyMaterializedAnalytics(ctx, {
      surveyId: args.surveyId,
      dateKey,
      includeTextInsights: true,
      now: args.now,
    });
  }

  return {
    createdSessions,
    createdResponses,
  };
}

async function runSeedForUser(
  ctx: MutationCtx,
  args: {
    owner: Doc<'appUsers'>;
    surveyCount: number;
    sessionsPerSurvey: number;
  },
) {
  const now = Date.now();
  const results: Array<{
    surveyId: Id<'surveys'>;
    slug: string;
    title: string;
    inviteToken: string;
    startedCount: number;
    completedCount: number;
    idleCount: number;
    abandonedCount: number;
    inProgressCount: number;
  }> = [];

  let createdSessions = 0;
  let createdResponses = 0;

  for (let surveyIndex = 0; surveyIndex < args.surveyCount; surveyIndex += 1) {
    const blueprint = surveyBlueprints[surveyIndex % surveyBlueprints.length];

    const insertedSurvey = await insertPublishedSurvey(ctx, {
      ownerId: args.owner._id,
      blueprint,
      surveyIndex,
      now,
    });

    const counts = countsForSessions(args.sessionsPerSurvey);

    const invite = await insertInvite(ctx, {
      ownerId: args.owner._id,
      surveyId: insertedSurvey.surveyId,
      versionId: insertedSurvey.versionId,
      maxCompletions: Math.max(counts.completed + 4, 8),
      now,
    });

    const runtime = await seedSurveyRuntime(ctx, {
      ownerId: args.owner._id,
      surveyId: insertedSurvey.surveyId,
      versionId: insertedSurvey.versionId,
      inviteId: invite.inviteId,
      fields: blueprint.fields,
      counts,
      surveyIndex,
      now,
    });

    createdSessions += runtime.createdSessions;
    createdResponses += runtime.createdResponses;

    await ctx.db.patch(invite.inviteId, {
      completionCount: counts.completed,
      status: counts.completed >= Math.max(counts.completed + 4, 8) ? 'exhausted' : 'active',
    });

    results.push({
      surveyId: insertedSurvey.surveyId,
      slug: insertedSurvey.slug,
      title: blueprint.title,
      inviteToken: invite.inviteToken,
      startedCount: args.sessionsPerSurvey,
      completedCount: counts.completed,
      idleCount: counts.idle,
      abandonedCount: counts.abandoned,
      inProgressCount: counts.inProgress,
    });
  }

  return {
    owner: {
      appUserId: args.owner._id,
      email: args.owner.email,
      role: args.owner.role,
    },
    createdSurveyCount: results.length,
    createdSessionCount: createdSessions,
    createdResponseCount: createdResponses,
    surveys: results,
    seededAt: now,
  };
}

export const seedMySurveyFixtures = mutation({
  args: seedArgsValidator,
  returns: seedResultValidator,
  handler: async (ctx, args) => {
    const owner = await requireAppUser(ctx);

    const surveyCount = clamp(Math.floor(args.surveyCount ?? 3), 1, 8);
    const sessionsPerSurvey = clamp(Math.floor(args.sessionsPerSurvey ?? 30), 8, 160);

    return await runSeedForUser(ctx, {
      owner,
      surveyCount,
      sessionsPerSurvey,
    });
  },
});

export const seedForFirstUser = internalMutation({
  args: {
    appUserId: v.optional(v.id('appUsers')),
    surveyCount: v.optional(v.number()),
    sessionsPerSurvey: v.optional(v.number()),
  },
  returns: seedResultValidator,
  handler: async (ctx, args) => {
    const owner = args.appUserId
      ? await ctx.db.get(args.appUserId)
      : await ctx.db.query('appUsers').withIndex('by_email').order('asc').first();

    if (!owner) {
      throw new Error('No appUsers found. Sign in once to initialize a user profile, then seed again.');
    }

    const surveyCount = clamp(Math.floor(args.surveyCount ?? 3), 1, 8);
    const sessionsPerSurvey = clamp(Math.floor(args.sessionsPerSurvey ?? 30), 8, 160);

    return await runSeedForUser(ctx, {
      owner,
      surveyCount,
      sessionsPerSurvey,
    });
  },
});
