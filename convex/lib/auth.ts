import { ConvexError } from 'convex/values';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

type Ctx = QueryCtx | MutationCtx;

export async function requireAuthIdentity(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required.',
    });
  }
  return identity;
}

export async function getCurrentAppUser(ctx: Ctx): Promise<Doc<'appUsers'> | null> {
  const identity = await requireAuthIdentity(ctx);
  return await ctx.db
    .query('appUsers')
    .withIndex('by_workos_user_id', (q) => q.eq('workosUserId', identity.subject))
    .unique();
}

export async function requireAdmin(ctx: Ctx): Promise<Doc<'appUsers'>> {
  const appUser = await getCurrentAppUser(ctx);

  if (!appUser) {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'User profile missing. Call upsertCurrentUser first.',
    });
  }

  if (appUser.role !== 'admin') {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'Admin role required.',
    });
  }

  return appUser;
}

export async function requireAppUser(ctx: Ctx): Promise<Doc<'appUsers'>> {
  const appUser = await getCurrentAppUser(ctx);

  if (!appUser) {
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'User profile missing. Refresh and try again.',
    });
  }

  return appUser;
}
