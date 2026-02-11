import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireAuthIdentity } from './lib/auth';

function parseAdminEmailAllowlist(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function canBecomeAdmin(email: string, hasExistingAdmin: boolean) {
  if (!hasExistingAdmin) {
    return true;
  }
  const allowlist = parseAdminEmailAllowlist();
  return allowlist.has(email.toLowerCase());
}

export const upsertCurrentUser = mutation({
  args: {},
  returns: v.object({
    appUserId: v.id('appUsers'),
    role: v.union(v.literal('admin'), v.literal('member')),
    email: v.string(),
  }),
  handler: async (ctx) => {
    const identity = await requireAuthIdentity(ctx);
    const now = Date.now();
    const email = identity.email ?? 'unknown@example.com';
    const allUsers = await ctx.db.query('appUsers').collect();
    const hasExistingAdmin = allUsers.some((user) => user.role === 'admin');
    const eligibleForAdmin = canBecomeAdmin(email, hasExistingAdmin);

    const existing = await ctx.db
      .query('appUsers')
      .withIndex('by_workos_user_id', (q) => q.eq('workosUserId', identity.subject))
      .unique();

    if (existing) {
      const role: 'admin' | 'member' =
        existing.role === 'admin' || eligibleForAdmin ? 'admin' : 'member';

      await ctx.db.patch(existing._id, {
        email,
        lastLoginAt: now,
        role,
      });

      return {
        appUserId: existing._id,
        role,
        email,
      };
    }

    const role: 'admin' | 'member' = eligibleForAdmin ? 'admin' : 'member';

    const appUserId = await ctx.db.insert('appUsers', {
      workosUserId: identity.subject,
      email,
      role,
      lastLoginAt: now,
      createdAt: now,
    });

    return {
      appUserId,
      role,
      email,
    };
  },
});

export const selfPromoteToAdmin = mutation({
  args: {},
  returns: v.object({
    appUserId: v.id('appUsers'),
    role: v.union(v.literal('admin'), v.literal('member')),
    email: v.string(),
  }),
  handler: async (ctx) => {
    const identity = await requireAuthIdentity(ctx);
    const email = identity.email ?? 'unknown@example.com';
    const now = Date.now();

    const appUser = await ctx.db
      .query('appUsers')
      .withIndex('by_workos_user_id', (q) => q.eq('workosUserId', identity.subject))
      .unique();

    if (!appUser) {
      throw new ConvexError({
        code: 'USER_NOT_INITIALIZED',
        message: 'User profile missing. Refresh once and try again.',
      });
    }

    if (appUser.role === 'admin') {
      return {
        appUserId: appUser._id,
        role: 'admin' as const,
        email: appUser.email,
      };
    }

    const allUsers = await ctx.db.query('appUsers').collect();
    const hasExistingAdmin = allUsers.some((user) => user.role === 'admin');
    const eligibleForAdmin = canBecomeAdmin(email, hasExistingAdmin);

    if (!eligibleForAdmin) {
      throw new ConvexError({
        code: 'FORBIDDEN',
        message:
          'Admin promotion is restricted. Set ADMIN_EMAILS in Convex env to allow this account.',
      });
    }

    await ctx.db.patch(appUser._id, {
      role: 'admin',
      email,
      lastLoginAt: now,
    });

    return {
      appUserId: appUser._id,
      role: 'admin' as const,
      email,
    };
  },
});

export const getCurrentUser = query({
  args: {},
  returns: v.union(
    v.object({
      appUserId: v.id('appUsers'),
      role: v.union(v.literal('admin'), v.literal('member')),
      email: v.string(),
      workosUserId: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const appUser = await ctx.db
      .query('appUsers')
      .withIndex('by_workos_user_id', (q) => q.eq('workosUserId', identity.subject))
      .unique();

    if (!appUser) {
      return null;
    }

    return {
      appUserId: appUser._id,
      role: appUser.role,
      email: appUser.email,
      workosUserId: appUser.workosUserId,
    };
  },
});
