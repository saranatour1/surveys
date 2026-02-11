import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { writeAuditLog } from './lib/domain';

export const log = internalMutation({
  args: {
    entityType: v.string(),
    entityId: v.string(),
    action: v.string(),
    actorType: v.union(v.literal('admin'), v.literal('system'), v.literal('respondent')),
    actorId: v.string(),
    metadata: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await writeAuditLog(ctx, args);
    return null;
  },
});
