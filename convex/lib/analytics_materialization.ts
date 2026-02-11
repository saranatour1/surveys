import { ConvexError } from 'convex/values';
import { DateTime } from 'luxon';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
  ANALYTICS_MAX_TEXT_SNIPPETS,
  ANALYTICS_MAX_TEXT_SNIPPET_LENGTH,
  ANALYTICS_MAX_TOP_PHRASES,
  ANALYTICS_MAX_WINDOW_DAYS,
} from './constants';
import { isAnswerPresent } from './utils';

type ReadCtx = QueryCtx | MutationCtx;

type FieldKind = Doc<'surveyVersions'>['fields'][number]['kind'];

type FieldAggregate = {
  fieldId: string;
  label: string;
  kind: FieldKind;
  order: number;
  reachedCount: number;
  answeredCount: number;
  bucketMap: Map<string, { label: string; count: number }>;
  textAnswers: string[];
  optionOrder: string[];
  optionLabels: Map<string, string>;
};

const TEXT_KINDS = new Set<FieldKind>(['short_text', 'long_text']);
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'with',
  'you',
  'your',
]);

export type AnalyticsDateRange = {
  fromDate: string;
  toDate: string;
  fromMillis: number;
  toMillis: number;
  dayKeys: string[];
};

type MaterializeOptions = {
  includeTextInsights?: boolean;
  now?: number;
};

function normalizeDateKey(dateKey: string): string {
  const parsed = DateTime.fromISO(dateKey, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new ConvexError({
      code: 'INVALID_DATE',
      message: `Invalid date: ${dateKey}`,
    });
  }
  return parsed.toISODate() ?? dateKey;
}

export function buildDateKeys(fromDate: string, toDate: string): string[] {
  const normalizedFrom = normalizeDateKey(fromDate);
  const normalizedTo = normalizeDateKey(toDate);
  const start = DateTime.fromISO(normalizedFrom, { zone: 'utc' }).startOf('day');
  const end = DateTime.fromISO(normalizedTo, { zone: 'utc' }).startOf('day');

  if (start > end) {
    return [];
  }

  const keys: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    keys.push(cursor.toISODate() ?? normalizedFrom);
    cursor = cursor.plus({ days: 1 });
  }
  return keys;
}

export function parseAnalyticsDateRange(args: {
  fromDate: string;
  toDate: string;
  maxDays?: number;
}): AnalyticsDateRange {
  const fromDate = normalizeDateKey(args.fromDate);
  const toDate = normalizeDateKey(args.toDate);
  const dayKeys = buildDateKeys(fromDate, toDate);
  if (dayKeys.length === 0) {
    throw new ConvexError({
      code: 'INVALID_DATE_RANGE',
      message: 'fromDate must be before or equal to toDate.',
    });
  }

  const maxDays = args.maxDays ?? ANALYTICS_MAX_WINDOW_DAYS;
  if (dayKeys.length > maxDays) {
    throw new ConvexError({
      code: 'ANALYTICS_WINDOW_TOO_LARGE',
      message: `Requested window is ${dayKeys.length} days. Max supported window is ${maxDays} days.`,
    });
  }

  return {
    fromDate,
    toDate,
    fromMillis: DateTime.fromISO(fromDate, { zone: 'utc' }).startOf('day').toMillis(),
    toMillis: DateTime.fromISO(toDate, { zone: 'utc' }).endOf('day').toMillis(),
    dayKeys,
  };
}

async function getResponsesForSurveyDate(
  ctx: ReadCtx,
  surveyId: Id<'surveys'>,
  dateKey: string,
): Promise<Doc<'surveyResponses'>[]> {
  const normalizedDate = normalizeDateKey(dateKey);
  const start = DateTime.fromISO(normalizedDate, { zone: 'utc' }).startOf('day').toMillis();
  const end = DateTime.fromISO(normalizedDate, { zone: 'utc' }).endOf('day').toMillis();

  const responses = await ctx.db
    .query('surveyResponses')
    .withIndex('by_survey_id', (q) => q.eq('surveyId', surveyId))
    .collect();

  return responses.filter((response) => response.submittedAt >= start && response.submittedAt <= end);
}

async function getVersion(
  ctx: ReadCtx,
  cache: Map<Id<'surveyVersions'>, Doc<'surveyVersions'> | null>,
  versionId: Id<'surveyVersions'>,
) {
  let version = cache.get(versionId);
  if (version === undefined) {
    version = await ctx.db.get(versionId);
    cache.set(versionId, version);
  }
  return version;
}

function sanitizeTextSnippet(value: string): string {
  const collapsed = value
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim();
  const redacted = collapsed
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b\d{3}[-.\s]?\d{2,3}[-.\s]?\d{4}\b/g, '[redacted-number]');
  if (redacted.length <= ANALYTICS_MAX_TEXT_SNIPPET_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, ANALYTICS_MAX_TEXT_SNIPPET_LENGTH - 1)}…`;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token));
}

function topPhraseRows(values: string[]) {
  const phraseCounts = new Map<string, number>();
  for (const value of values) {
    const tokens = tokenize(value);
    for (const token of tokens) {
      phraseCounts.set(token, (phraseCounts.get(token) ?? 0) + 1);
    }
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const phrase = `${tokens[index]} ${tokens[index + 1]}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
  }

  return Array.from(phraseCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ANALYTICS_MAX_TOP_PHRASES)
    .map(([phrase, count]) => ({ phrase, count }));
}

function snippetRows(values: string[]) {
  const counts = new Map<string, number>();
  for (const rawValue of values) {
    const snippet = sanitizeTextSnippet(rawValue);
    if (!snippet) {
      continue;
    }
    counts.set(snippet, (counts.get(snippet) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ANALYTICS_MAX_TEXT_SNIPPETS)
    .map(([snippet, count]) => ({ snippet, count }));
}

function formatNumberBucket(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(2);
}

function bucketEntriesForAnswer(
  field: Doc<'surveyVersions'>['fields'][number],
  answer: unknown,
): Array<{ key: string; label: string }> {
  const optionLabelByValue = new Map((field.options ?? []).map((option) => [option.value, option.label]));

  switch (field.kind) {
    case 'single_select': {
      if (typeof answer !== 'string') {
        return [];
      }
      const value = answer.trim();
      if (!value) {
        return [];
      }
      return [{ key: value, label: optionLabelByValue.get(value) ?? value }];
    }
    case 'multi_select': {
      if (!Array.isArray(answer)) {
        return [];
      }
      return answer
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => ({ key: entry, label: optionLabelByValue.get(entry) ?? entry }));
    }
    case 'number':
    case 'rating_1_5': {
      if (typeof answer !== 'number' || Number.isNaN(answer)) {
        return [];
      }
      const key = formatNumberBucket(answer);
      return [{ key, label: key }];
    }
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'date':
      return [{ key: '__provided__', label: 'Provided' }];
  }
}

async function upsertSurveyAnalyticsDailyRow(
  ctx: MutationCtx,
  row: {
    surveyId: Id<'surveys'>;
    dateKey: string;
    started: number;
    completed: number;
    idle: number;
    abandoned: number;
    reactivated: number;
    avgScorePercent: number;
    totalGraded: number;
    updatedAt: number;
  },
) {
  const existing = await ctx.db
    .query('surveyAnalyticsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', row.surveyId).eq('dateKey', row.dateKey))
    .collect();

  if (existing.length === 0) {
    await ctx.db.insert('surveyAnalyticsDaily', row);
    return;
  }

  const [first, ...duplicates] = existing;
  await ctx.db.patch(first._id, row);
  for (const duplicate of duplicates) {
    await ctx.db.delete(duplicate._id);
  }
}

async function syncDailyFieldRows(
  ctx: MutationCtx,
  surveyId: Id<'surveys'>,
  dateKey: string,
  rows: Array<{
    fieldId: string;
    reachedCount: number;
    answeredCount: number;
    dropoffCount: number;
    updatedAt: number;
  }>,
) {
  const existing = await ctx.db
    .query('surveyFieldAnalyticsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', surveyId).eq('dateKey', dateKey))
    .collect();

  const existingByField = new Map<string, Doc<'surveyFieldAnalyticsDaily'>>();
  for (const row of existing) {
    if (existingByField.has(row.fieldId)) {
      await ctx.db.delete(row._id);
      continue;
    }
    existingByField.set(row.fieldId, row);
  }

  for (const row of rows) {
    const existingRow = existingByField.get(row.fieldId);
    const payload = {
      surveyId,
      fieldId: row.fieldId,
      dateKey,
      reachedCount: row.reachedCount,
      answeredCount: row.answeredCount,
      dropoffCount: row.dropoffCount,
      updatedAt: row.updatedAt,
    };
    if (existingRow) {
      await ctx.db.patch(existingRow._id, payload);
      existingByField.delete(row.fieldId);
    } else {
      await ctx.db.insert('surveyFieldAnalyticsDaily', payload);
    }
  }

  for (const staleRow of existingByField.values()) {
    await ctx.db.delete(staleRow._id);
  }
}

async function syncDailyBucketRows(
  ctx: MutationCtx,
  surveyId: Id<'surveys'>,
  dateKey: string,
  rows: Array<{
    fieldId: string;
    bucketKey: string;
    bucketLabel: string;
    count: number;
    updatedAt: number;
  }>,
) {
  const existing = await ctx.db
    .query('surveyAnswerBucketsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', surveyId).eq('dateKey', dateKey))
    .collect();

  const existingByKey = new Map<string, Doc<'surveyAnswerBucketsDaily'>>();
  for (const row of existing) {
    const key = `${row.fieldId}::${row.bucketKey}`;
    if (existingByKey.has(key)) {
      await ctx.db.delete(row._id);
      continue;
    }
    existingByKey.set(key, row);
  }

  for (const row of rows) {
    const key = `${row.fieldId}::${row.bucketKey}`;
    const existingRow = existingByKey.get(key);
    const payload = {
      surveyId,
      fieldId: row.fieldId,
      dateKey,
      bucketKey: row.bucketKey,
      bucketLabel: row.bucketLabel,
      count: row.count,
      updatedAt: row.updatedAt,
    };
    if (existingRow) {
      await ctx.db.patch(existingRow._id, payload);
      existingByKey.delete(key);
    } else {
      await ctx.db.insert('surveyAnswerBucketsDaily', payload);
    }
  }

  for (const staleRow of existingByKey.values()) {
    await ctx.db.delete(staleRow._id);
  }
}

async function syncDailyTextRows(
  ctx: MutationCtx,
  surveyId: Id<'surveys'>,
  dateKey: string,
  rows: Array<{
    fieldId: string;
    topPhrases: Array<{ phrase: string; count: number }>;
    sampledSnippets: Array<{ snippet: string; count: number }>;
    updatedAt: number;
  }>,
) {
  const existing = await ctx.db
    .query('surveyTextInsightsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', surveyId).eq('dateKey', dateKey))
    .collect();

  const existingByField = new Map<string, Doc<'surveyTextInsightsDaily'>>();
  for (const row of existing) {
    if (existingByField.has(row.fieldId)) {
      await ctx.db.delete(row._id);
      continue;
    }
    existingByField.set(row.fieldId, row);
  }

  for (const row of rows) {
    const existingRow = existingByField.get(row.fieldId);
    const payload = {
      surveyId,
      fieldId: row.fieldId,
      dateKey,
      topPhrases: row.topPhrases,
      sampledSnippets: row.sampledSnippets,
      updatedAt: row.updatedAt,
    };
    if (existingRow) {
      await ctx.db.patch(existingRow._id, payload);
      existingByField.delete(row.fieldId);
    } else {
      await ctx.db.insert('surveyTextInsightsDaily', payload);
    }
  }

  for (const staleRow of existingByField.values()) {
    await ctx.db.delete(staleRow._id);
  }
}

function getOrCreateFieldAggregate(
  aggregates: Map<string, FieldAggregate>,
  field: Doc<'surveyVersions'>['fields'][number],
) {
  const existing = aggregates.get(field.id);
  if (existing) {
    return existing;
  }

  const next: FieldAggregate = {
    fieldId: field.id,
    label: field.label,
    kind: field.kind,
    order: field.order,
    reachedCount: 0,
    answeredCount: 0,
    bucketMap: new Map<string, { label: string; count: number }>(),
    textAnswers: [],
    optionOrder: (field.options ?? []).map((option) => option.value),
    optionLabels: new Map((field.options ?? []).map((option) => [option.value, option.label])),
  };
  aggregates.set(field.id, next);
  return next;
}

export async function rebuildDailyMaterializedAnalytics(
  ctx: MutationCtx,
  args: {
    surveyId: Id<'surveys'>;
    dateKey: string;
  } & MaterializeOptions,
) {
  const normalizedDate = normalizeDateKey(args.dateKey);
  const now = args.now ?? Date.now();
  const includeTextInsights = args.includeTextInsights ?? false;
  const responses = await getResponsesForSurveyDate(ctx, args.surveyId, normalizedDate);
  const versionCache = new Map<Id<'surveyVersions'>, Doc<'surveyVersions'> | null>();
  const fieldAggregates = new Map<string, FieldAggregate>();

  let totalGraded = 0;
  let sumScorePercent = 0;

  for (const response of responses) {
    if (response.grading && response.grading.gradableCount > 0) {
      totalGraded += 1;
      sumScorePercent += response.grading.scorePercent;
    }

    const version = await getVersion(ctx, versionCache, response.surveyVersionId);
    if (!version) {
      continue;
    }

    const fields = [...version.fields].sort((a, b) => a.order - b.order);
    if (fields.length === 0) {
      continue;
    }

    let maxReachedOrder = 0;
    for (const field of fields) {
      const answer = response.answers[field.id];
      if (isAnswerPresent(answer)) {
        maxReachedOrder = Math.max(maxReachedOrder, field.order);
      }
    }

    for (const field of fields) {
      const aggregate = getOrCreateFieldAggregate(fieldAggregates, field);

      if (field.order <= maxReachedOrder) {
        aggregate.reachedCount += 1;
      }

      const answer = response.answers[field.id];
      if (!isAnswerPresent(answer)) {
        continue;
      }

      aggregate.answeredCount += 1;

      for (const entry of bucketEntriesForAnswer(field, answer)) {
        const bucket = aggregate.bucketMap.get(entry.key) ?? { label: entry.label, count: 0 };
        bucket.count += 1;
        aggregate.bucketMap.set(entry.key, bucket);
      }

      if (TEXT_KINDS.has(field.kind) && typeof answer === 'string' && answer.trim().length > 0) {
        aggregate.textAnswers.push(answer);
      }
    }
  }

  const metrics = await ctx.db
    .query('surveyMetricsDaily')
    .withIndex('by_survey_and_date', (q) => q.eq('surveyId', args.surveyId).eq('dateKey', normalizedDate))
    .unique();

  const completedCount = Math.max(metrics?.completed ?? 0, responses.length);
  const startedCount = Math.max(metrics?.started ?? 0, completedCount);
  const avgScorePercent = totalGraded > 0 ? Math.round((sumScorePercent / totalGraded) * 100) / 100 : 0;

  await upsertSurveyAnalyticsDailyRow(ctx, {
    surveyId: args.surveyId,
    dateKey: normalizedDate,
    started: startedCount,
    completed: completedCount,
    idle: metrics?.idle ?? 0,
    abandoned: metrics?.abandoned ?? 0,
    reactivated: metrics?.reactivated ?? 0,
    avgScorePercent,
    totalGraded,
    updatedAt: now,
  });

  const fieldRows = Array.from(fieldAggregates.values())
    .sort((a, b) => a.order - b.order)
    .map((aggregate) => ({
      fieldId: aggregate.fieldId,
      reachedCount: aggregate.reachedCount,
      answeredCount: aggregate.answeredCount,
      dropoffCount: Math.max(aggregate.reachedCount - aggregate.answeredCount, 0),
      updatedAt: now,
    }));

  await syncDailyFieldRows(ctx, args.surveyId, normalizedDate, fieldRows);

  const bucketRows = Array.from(fieldAggregates.values()).flatMap((aggregate) => {
    const rows = Array.from(aggregate.bucketMap.entries()).map(([bucketKey, bucket]) => ({
      fieldId: aggregate.fieldId,
      bucketKey,
      bucketLabel: bucket.label,
      count: bucket.count,
      updatedAt: now,
    }));

    if (aggregate.kind === 'single_select' || aggregate.kind === 'multi_select') {
      for (const optionValue of aggregate.optionOrder) {
        const key = `${aggregate.fieldId}::${optionValue}`;
        const hasOption = rows.some((row) => `${row.fieldId}::${row.bucketKey}` === key);
        if (!hasOption) {
          rows.push({
            fieldId: aggregate.fieldId,
            bucketKey: optionValue,
            bucketLabel: aggregate.optionLabels.get(optionValue) ?? optionValue,
            count: 0,
            updatedAt: now,
          });
        }
      }
    }

    if (aggregate.kind === 'rating_1_5') {
      for (const rating of ['1', '2', '3', '4', '5']) {
        const key = `${aggregate.fieldId}::${rating}`;
        const hasRating = rows.some((row) => `${row.fieldId}::${row.bucketKey}` === key);
        if (!hasRating) {
          rows.push({
            fieldId: aggregate.fieldId,
            bucketKey: rating,
            bucketLabel: rating,
            count: 0,
            updatedAt: now,
          });
        }
      }
    }

    return rows;
  });

  await syncDailyBucketRows(ctx, args.surveyId, normalizedDate, bucketRows);

  if (includeTextInsights) {
    const textRows = Array.from(fieldAggregates.values())
      .filter((aggregate) => TEXT_KINDS.has(aggregate.kind))
      .map((aggregate) => ({
        fieldId: aggregate.fieldId,
        topPhrases: topPhraseRows(aggregate.textAnswers),
        sampledSnippets: snippetRows(aggregate.textAnswers),
        updatedAt: now,
      }));

    await syncDailyTextRows(ctx, args.surveyId, normalizedDate, textRows);
  }
}

export async function refreshDailyTextInsights(
  ctx: MutationCtx,
  args: {
    surveyId: Id<'surveys'>;
    dateKey: string;
    now?: number;
  },
) {
  const normalizedDate = normalizeDateKey(args.dateKey);
  const now = args.now ?? Date.now();
  const responses = await getResponsesForSurveyDate(ctx, args.surveyId, normalizedDate);
  const versionCache = new Map<Id<'surveyVersions'>, Doc<'surveyVersions'> | null>();
  const textAnswersByField = new Map<string, string[]>();

  for (const response of responses) {
    const version = await getVersion(ctx, versionCache, response.surveyVersionId);
    if (!version) {
      continue;
    }

    for (const field of version.fields) {
      if (!TEXT_KINDS.has(field.kind)) {
        continue;
      }
      const answer = response.answers[field.id];
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        continue;
      }
      const existing = textAnswersByField.get(field.id) ?? [];
      existing.push(answer);
      textAnswersByField.set(field.id, existing);
    }
  }

  const rows = Array.from(textAnswersByField.entries()).map(([fieldId, answers]) => ({
    fieldId,
    topPhrases: topPhraseRows(answers),
    sampledSnippets: snippetRows(answers),
    updatedAt: now,
  }));

  await syncDailyTextRows(ctx, args.surveyId, normalizedDate, rows);
}

export async function getSurveyFieldMetaMap(
  ctx: ReadCtx,
  surveyId: Id<'surveys'>,
): Promise<
  Map<
    string,
    {
      label: string;
      kind: FieldKind;
      order: number;
      optionOrder: string[];
      optionLabels: Map<string, string>;
    }
  >
> {
  const versions = await ctx.db
    .query('surveyVersions')
    .withIndex('by_survey_id', (q) => q.eq('surveyId', surveyId))
    .collect();

  const byVersion = [...versions].sort((a, b) => b.version - a.version);
  const map = new Map<
    string,
    {
      label: string;
      kind: FieldKind;
      order: number;
      optionOrder: string[];
      optionLabels: Map<string, string>;
    }
  >();

  for (const version of byVersion) {
    for (const field of version.fields) {
      if (map.has(field.id)) {
        continue;
      }
      map.set(field.id, {
        label: field.label,
        kind: field.kind,
        order: field.order,
        optionOrder: (field.options ?? []).map((option) => option.value),
        optionLabels: new Map((field.options ?? []).map((option) => [option.value, option.label])),
      });
    }
  }

  return map;
}
