import { defineApp } from 'convex/server';
import posthog from '../posthog-convex/src/component/convex.config';

const app = defineApp();
app.use(posthog);

export default app;
           