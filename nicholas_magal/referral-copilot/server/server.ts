import { analytics, createApp, lakebase, server, serving } from '@databricks/appkit';
import { setupReferralRoutes } from './routes/referral-routes';

createApp({
  plugins: [
    lakebase(),
    analytics({}),
    serving({
      endpoints: {
        referral: { env: 'DATABRICKS_SERVING_ENDPOINT_NAME' },
      },
    }),
    server(),
  ],
  async onPluginsReady(appkit) {
    await setupReferralRoutes(appkit);
  },
}).catch(console.error);
