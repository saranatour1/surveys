import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval('mark-idle-sessions', { minutes: 5 }, internal.sessions.markIdleBatch, {});
crons.interval('mark-abandoned-sessions', { minutes: 10 }, internal.sessions.markAbandonedBatch, {});
crons.interval('flush-posthog-outbox', { minutes: 1 }, internal.analytics.flushOutbox, {});

export default crons;
