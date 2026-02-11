import { v } from 'convex/values';

export const appUserRoleValidator = v.union(v.literal('admin'), v.literal('member'));

export const surveyStatusValidator = v.union(v.literal('draft'), v.literal('published'), v.literal('archived'));

export const inviteStatusValidator = v.union(
  v.literal('active'),
  v.literal('revoked'),
  v.literal('exhausted'),
  v.literal('expired'),
);

export const sessionStatusValidator = v.union(
  v.literal('in_progress'),
  v.literal('idle'),
  v.literal('abandoned'),
  v.literal('completed'),
);

export const fieldKindValidator = v.union(
  v.literal('short_text'),
  v.literal('long_text'),
  v.literal('single_select'),
  v.literal('multi_select'),
  v.literal('number'),
  v.literal('email'),
  v.literal('date'),
  v.literal('rating_1_5'),
);

export const fieldOptionValidator = v.object({
  label: v.string(),
  value: v.string(),
});

export const fieldValidationValidator = v.object({
  minLength: v.optional(v.number()),
  maxLength: v.optional(v.number()),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  pattern: v.optional(v.string()),
});

export const fieldCorrectnessValidator = v.union(
  v.object({
    mode: v.literal('text_exact'),
    expectedText: v.string(),
    normalization: v.literal('trim_lower'),
  }),
  v.object({
    mode: v.literal('single_select_exact'),
    expectedOptionValue: v.string(),
  }),
  v.object({
    mode: v.literal('multi_select_exact'),
    expectedOptionValues: v.array(v.string()),
  }),
  v.object({
    mode: v.literal('numeric_exact'),
    expectedNumber: v.number(),
    tolerance: v.optional(v.number()),
  }),
);

export const surveyFieldValidator = v.object({
  id: v.string(),
  kind: fieldKindValidator,
  label: v.string(),
  required: v.boolean(),
  order: v.number(),
  placeholder: v.optional(v.string()),
  helpText: v.optional(v.string()),
  options: v.optional(v.array(fieldOptionValidator)),
  validation: v.optional(fieldValidationValidator),
  correctness: v.optional(fieldCorrectnessValidator),
});

export const surveySettingsValidator = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  showProgressBar: v.optional(v.boolean()),
});

export const answerValueValidator = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.array(v.string()),
  v.null(),
);

export const answersValidator = v.record(v.string(), answerValueValidator);

export const responseGradingValidator = v.object({
  gradableCount: v.number(),
  correctCount: v.number(),
  incorrectCount: v.number(),
  scorePercent: v.number(),
  fieldResults: v.record(v.string(), v.object({ isCorrect: v.boolean() })),
});

export const textInsightPhraseValidator = v.object({
  phrase: v.string(),
  count: v.number(),
});

export const textInsightSnippetValidator = v.object({
  snippet: v.string(),
  count: v.number(),
});

export const posthogOutboxStatusValidator = v.union(v.literal('pending'), v.literal('sent'), v.literal('failed'));

export const dailyMetricNameValidator = v.union(
  v.literal('started'),
  v.literal('completed'),
  v.literal('idle'),
  v.literal('abandoned'),
  v.literal('reactivated'),
);
