import { analytics, createApp, server, serving } from '@databricks/appkit';

createApp({
  plugins: [
    server(),
    analytics({}),
    serving(),
  ],
}).catch(console.error);
