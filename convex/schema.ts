import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  answersValidator,
  appUserRoleValidator,
  inviteStatusValidator,
  posthogOutboxStatusValidator,
  responseGradingValidator,
  sessionStatusValidator,
  surveyFieldValidator,
  surveySettingsValidator,
  surveyStatusValidator,
  textInsightPhraseValidator,
  textInsightSnippetValidator,
} from './lib/validators';

export default defineSchema({
  appUsers: defineTable({
    workosUserId: v.string(),
    email: v.string(),
    role: appUserRoleValidator,
    lastLoginAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_workos_user_id', ['workosUserId'])
    .index('by_email', ['email']),

  surveys: defineTable({
    slug: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: surveyStatusValidator,
    currentVersionId: v.optional(v.id('surveyVersions')),
    createdByUserId: v.id('appUsers'),
    updatedByUserId: v.id('appUsers'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_status', ['status'])
    .index('by_updated_at', ['updatedAt']),

  surveyVersions: defineTable({
    surveyId: v.id('surveys'),
    version: v.number(),
    fields: v.array(surveyFieldValidator),
    settings: surveySettingsValidator,
    createdByUserId: v.id('appUsers'),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index('by_survey_id', ['surveyId'])
    .index('by_survey_and_version', ['surveyId', 'version']),

  surveyInvites: defineTable({
    surveyId: v.id('surveys'),
    surveyVersionId: v.id('surveyVersions'),
    tokenHash: v.string(),
    status: inviteStatusValidator,
    maxCompletions: v.number(),
    completionCount: v.number(),
    expiresAt: v.optional(v.number()),
    createdByUserId: v.id('appUsers'),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index('by_token_hash', ['tokenHash'])
    .index('by_survey_id', ['surveyId'])
    .index('by_status_and_expires_at', ['status', 'expiresAt']),

  surveySessions: defineTable({
    sessionPublicId: v.string(),
    surveyId: v.id('surveys'),
    surveyVersionId: v.id('surveyVersions'),
    inviteId: v.id('surveyInvites'),
    respondentKey: v.string(),
    status: sessionStatusValidator,
    startedAt: v.number(),
    lastActivityAt: v.number(),
    completedAt: v.optional(v.number()),
    answersDraft: answersValidator,
  })
    .index('by_session_public_id', ['sessionPublicId'])
    .index('by_invite_id', ['inviteId'])
    .index('by_survey_and_status', ['surveyId', 'status'])
    .index('by_status_and_last_activity', ['status', 'lastActivityAt']),

  surveyResponses: defineTable({
    sessionId: v.id('surveySessions'),
    sessionPublicId: v.string(),
    surveyId: v.id('surveys'),
    surveyVersionId: v.id('surveyVersions'),
    inviteId: v.id('surveyInvites'),
    submittedAt: v.number(),
    answers: answersValidator,
    durationMs: v.number(),
    grading: v.optional(responseGradingValidator),
  })
    .index('by_session_id', ['sessionId'])
    .index('by_survey_id', ['surveyId'])
    .index('by_submitted_at', ['submittedAt']),

  sessionTransitions: defineTable({
    sessionId: v.id('surveySessions'),
    surveyId: v.id('surveys'),
    fromStatus: v.optional(sessionStatusValidator),
    toStatus: sessionStatusValidator,
    reason: v.string(),
    at: v.number(),
  })
    .index('by_session_and_at', ['sessionId', 'at'])
    .index('by_survey_and_at', ['surveyId', 'at']),

  surveyMetricsDaily: defineTable({
    surveyId: v.id('surveys'),
    dateKey: v.string(),
    started: v.number(),
    completed: v.number(),
    idle: v.number(),
    abandoned: v.number(),
    reactivated: v.number(),
    updatedAt: v.number(),
  }).index('by_survey_and_date', ['surveyId', 'dateKey']),

  surveyAnalyticsDaily: defineTable({
    surveyId: v.id('surveys'),
    dateKey: v.string(),
    started: v.number(),
    completed: v.number(),
    idle: v.number(),
    abandoned: v.number(),
    reactivated: v.number(),
    avgScorePercent: v.number(),
    totalGraded: v.number(),
    updatedAt: v.number(),
  }).index('by_survey_and_date', ['surveyId', 'dateKey']),

  surveyFieldAnalyticsDaily: defineTable({
    surveyId: v.id('surveys'),
    fieldId: v.string(),
    dateKey: v.string(),
    reachedCount: v.number(),
    answeredCount: v.number(),
    dropoffCount: v.number(),
    updatedAt: v.number(),
  })
    .index('by_survey_field_and_date', ['surveyId', 'fieldId', 'dateKey'])
    .index('by_survey_and_date', ['surveyId', 'dateKey']),

  surveyAnswerBucketsDaily: defineTable({
    surveyId: v.id('surveys'),
    fieldId: v.string(),
    dateKey: v.string(),
    bucketKey: v.string(),
    bucketLabel: v.string(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index('by_survey_field_date', ['surveyId', 'fieldId', 'dateKey'])
    .index('by_survey_field_bucket', ['surveyId', 'fieldId', 'bucketKey'])
    .index('by_survey_and_date', ['surveyId', 'dateKey']),

  surveyTextInsightsDaily: defineTable({
    surveyId: v.id('surveys'),
    fieldId: v.string(),
    dateKey: v.string(),
    topPhrases: v.array(textInsightPhraseValidator),
    sampledSnippets: v.array(textInsightSnippetValidator),
    updatedAt: v.number(),
  })
    .index('by_survey_field_and_date', ['surveyId', 'fieldId', 'dateKey'])
    .index('by_survey_and_date', ['surveyId', 'dateKey']),

  analyticsOutbox: defineTable({
    eventName: v.string(),
    distinctId: v.string(),
    properties: v.any(),
    status: posthogOutboxStatusValidator,
    attemptCount: v.number(),
    nextAttemptAt: v.number(),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index('by_status_and_next_attempt', ['status', 'nextAttemptAt'])
    .index('by_created_at', ['createdAt']),

  auditLogs: defineTable({
    entityType: v.string(),
    entityId: v.string(),
    action: v.string(),
    actorType: v.union(v.literal('admin'), v.literal('system'), v.literal('respondent')),
    actorId: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('by_entity', ['entityType', 'entityId'])
    .index('by_created_at', ['createdAt']),
});
