import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { bumpDailyMetric } from './lib/domain';
import { dailyMetricNameValidator } from './lib/validators';

export const bumpDaily = internalMutation({
  args: {
    surveyId: v.id('surveys'),
    metric: dailyMetricNameValidator,
    delta: v.optional(v.number()),
    timestamp: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await bumpDailyMetric(ctx, {
      surveyId: args.surveyId,
      metric: args.metric,
      delta: args.delta,
      timestamp: args.timestamp,
    });
    return null;
  },
});
