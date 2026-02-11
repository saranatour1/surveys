import { ConvexError } from 'convex/values';
import { DateTime } from 'luxon';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { validateAnswerWithZod } from './zod';

type ReadCtx = QueryCtx | MutationCtx;

export function dateKeyFromTimestamp(timestamp: number): string {
  return DateTime.fromMillis(timestamp, { zone: 'utc' }).toISODate() ?? '1970-01-01';
}

export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function randomInviteToken(): string {
  return `inv_${crypto.randomUUID().replace(/-/g, '')}`;
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getInviteByToken(
  ctx: ReadCtx,
  inviteToken: string,
): Promise<Doc<'surveyInvites'> | null> {
  const tokenHash = await hashToken(inviteToken);
  return await ctx.db
    .query('surveyInvites')
    .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
    .unique();
}

export function assertUniqueFieldIds(fields: Array<{ id: string }>) {
  const ids = new Set<string>();
  for (const field of fields) {
    if (ids.has(field.id)) {
      throw new ConvexError({
        code: 'INVALID_FIELD_ID',
        message: `Duplicate field id: ${field.id}`,
      });
    }
    ids.add(field.id);
  }
}

export function getFieldMap(version: Doc<'surveyVersions'>): Map<string, Doc<'surveyVersions'>['fields'][number]> {
  return new Map(version.fields.map((field) => [field.id, field]));
}

export function isInviteUsable(invite: Doc<'surveyInvites'>, now: number): boolean {
  if (invite.status !== 'active') {
    return false;
  }
  if (invite.expiresAt !== undefined && invite.expiresAt !== null && invite.expiresAt < now) {
    return false;
  }
  if (invite.completionCount >= invite.maxCompletions) {
    return false;
  }
  return true;
}

export function calculateProgress(
  fields: Doc<'surveyVersions'>['fields'],
  answers: Record<string, unknown>,
): { answeredCount: number; requiredAnsweredCount: number; requiredCount: number; progressPercent: number } {
  const requiredFields = fields.filter((field) => field.required);
  const requiredCount = requiredFields.length;

  let answeredCount = 0;
  let requiredAnsweredCount = 0;

  for (const field of fields) {
    const value = answers[field.id];
    if (isAnswerPresent(value)) {
      answeredCount += 1;
      if (field.required) {
        requiredAnsweredCount += 1;
      }
    }
  }

  const denominator = requiredCount > 0 ? requiredCount : fields.length || 1;
  const numerator = requiredCount > 0 ? requiredAnsweredCount : answeredCount;

  return {
    answeredCount,
    requiredAnsweredCount,
    requiredCount,
    progressPercent: Math.round((numerator / denominator) * 100),
  };
}

export function isAnswerPresent(value: unknown): boolean {
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

export function validateAnswerForField(
  field: Doc<'surveyVersions'>['fields'][number],
  value: unknown,
): void {
  const zodError = validateAnswerWithZod(field, value);
  if (zodError) {
    throw new ConvexError({
      code: 'INVALID_ANSWER',
      fieldId: field.id,
      message: zodError,
    });
  }
}
