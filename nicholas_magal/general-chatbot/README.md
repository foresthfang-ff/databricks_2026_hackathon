# general-chatbot

A Databricks AppKit app that provides a healthcare facility chatbot grounded only in Unity Catalog facility tables and backed by a Databricks Model Serving chat endpoint.

## Enabled Plugins

- **Server**: Express HTTP server with static file serving and Vite dev mode
- **Analytics**: Read-only SQL grounding queries against a Databricks SQL warehouse
- **Serving**: Authenticated proxy to Databricks Model Serving

The default bundle target points at `https://dbc-23f8f625-632f.cloud.databricks.com`, uses warehouse `57f2d24b9a91fb7f`, and uses the ready endpoint `databricks-meta-llama-3-1-8b-instruct`.

Grounding reads these tables through `config/queries/facility_grounding.sql`:

- `medallion_architecture.gold.gold_facility`
- `medallion_architecture.gold.gold_facility_contact`
- `medallion_architecture.gold.gold_facility_location`
- `medallion_architecture.gold.gold_facility_procedure`
- `medallion_architecture.gold.gold_facility_specialty`

## Local Development

Install dependencies:

```bash
npm install
```

For local serving calls, create `general-chatbot/.env` with:

```env
DATABRICKS_HOST=https://dbc-23f8f625-632f.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=57f2d24b9a91fb7f
DATABRICKS_SERVING_ENDPOINT_NAME=databricks-meta-llama-3-1-8b-instruct
DATABRICKS_APP_PORT=8000
```

Then run:

```bash
npm run dev
```

## Validation

```bash
npm run typecheck
npm run lint
npm run test:smoke
databricks apps validate --profile dbc-23f8f625-632f
```

## Deployment

Deploying changes a Databricks workspace app, so confirm the target before running:

```bash
databricks apps deploy --profile dbc-23f8f625-632f
```

## Key Files

- `client/src/App.tsx`: chatbot UI and AppKit serving hook usage
- `config/queries/facility_grounding.sql`: compact facility retrieval query
- `server/server.ts`: AppKit server with the serving plugin
- `databricks.yml`: app resource declarations and warehouse/endpoint permissions
- `app.yaml`: runtime injection for warehouse and serving endpoint names
