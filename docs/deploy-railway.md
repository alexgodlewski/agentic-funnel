# Deploy To Railway

AgenticFunnel includes two Railway configs:

- `railway.json`: web app.
- `railway.worker.json`: worker process.

## Services

Create:

- Postgres database.
- Web service using `railway.json`.
- Worker service using `railway.worker.json`.
- S3-compatible storage provider, either outside Railway or via your preferred provider.

## Commands

Web build:

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm --filter @agentic-funnel/web build
```

Web start:

```bash
sh start.sh
```

Worker start:

```bash
pnpm --filter @agentic-funnel/worker start
```

## After Deploy

- Set all production env vars.
- Run database migrations.
- Configure Stripe live webhook URL.
- Verify `/api/health`.
- Verify the worker health port.
