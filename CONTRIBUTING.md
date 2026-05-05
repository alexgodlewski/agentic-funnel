# Contributing

Thanks for helping improve AgenticFunnel.

## Local Setup

```bash
cp .env.example .env
pnpm install
pnpm local:up
pnpm db:push
pnpm db:seed:assets
pnpm dev:web
```

Run the worker in another terminal:

```bash
pnpm dev:worker
```

## Verification

Before opening a pull request, run:

```bash
pnpm check:web
pnpm check:worker
pnpm build
pnpm test
```

## Contribution Scope

Good first contributions include docs improvements, provider adapters, tests around checkout/fulfillment behavior, and small UX fixes to the funnel pages.

For larger changes, open an issue first so the direction can be discussed before implementation.

## Security

Do not commit real API keys, customer data, webhook payloads, database dumps, or private funnel assets. Use `.env.example` placeholders in docs and tests.
