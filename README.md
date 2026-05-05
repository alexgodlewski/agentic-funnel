# AgenticFunnel

Open-source Stripe funnel infrastructure for low-ticket digital products.

AgenticFunnel is a production-shaped starter for builders who sell playbooks, templates, workshops, mini-courses, and other low-ticket offers. It gives you a real checkout funnel without starting from blank files: an Astro web app, Stripe Payment Element checkout, order bumps, post-purchase offers, signed digital downloads, Postgres/Drizzle, pg-boss worker jobs, and optional analytics/email integrations.

It is intentionally code-first and self-hostable. Bring your own Stripe account, Postgres database, S3-compatible storage, and provider keys; keep the funnel logic in a repository you control.

## Features

- Landing page, checkout, OTO, downsell, and thank-you routes.
- Stripe Payment Element with server-created PaymentIntents.
- Order bumps and deterministic quote calculation.
- Post-purchase offer tokens with expiry.
- Digital fulfillment through signed S3/R2/MinIO links.
- Background worker for fulfillment, outbox delivery, analytics, and recovery jobs.
- Optional PostHog, Meta CAPI, Hyros, Mailgun, and MailerLite integrations.
- Local Postgres and MinIO via Docker Compose.

## Who It Is For

- Solo builders selling low-ticket digital products.
- Operators who want ownership of their funnel code and customer data.
- Developers building reusable checkout infrastructure for info products.
- Teams that want a practical Stripe reference implementation with tests.

AgenticFunnel is not a hosted funnel builder. It is an open-source model you can fork, study, customize, and deploy.

## Workspace

- `apps/web`: Astro SSR app, buyer pages, and HTTP APIs.
- `apps/worker`: background jobs and provider dispatchers.
- `packages/db`: Drizzle schema, migrations, and seed script.
- `packages/shared`: shared schemas, events, crypto helpers, and job names.

## Quick Start

```bash
cp .env.example .env
pnpm install
pnpm local:up
pnpm db:push
pnpm db:seed:assets
pnpm dev:web
```

In another terminal:

```bash
pnpm dev:worker
```

Open `http://localhost:4321`.

Stripe is required for realistic payment testing. The starter catalog, placeholder assets, and neutral starter pages are committed so tests and docs work before Stripe setup, but real checkout requires your own Stripe test keys, Price IDs, product images, fulfillment files, landing page design, and legal copy.

## Configure Stripe

1. Create Products and Prices for the starter slots: CORE, ORDER_BUMP_1, ORDER_BUMP_2, OTO, DOWNSELL.
2. Add Product metadata `r2_key` matching each asset path.
3. Fill `STRIPE_TEST_*` values in `.env`.
4. Run:

```bash
pnpm --filter @agentic-funnel/web sync:stripe
```

This writes `apps/web/src/lib/config/funnels.generated.ts` from Stripe. Stripe owns names, prices, currencies, and default `r2_key` values; `apps/web/src/lib/config/funnels.ts` owns display copy and multi-file fulfillment overrides.

## Customize Your Funnel

Start here:

- Landing page: `apps/web/src/pages/index.astro`
- Checkout page: `apps/web/src/pages/checkout.astro`
- OTO page: `apps/web/src/pages/oto/[token].astro`
- Downsell page: `apps/web/src/pages/downsell/[token].astro`
- Thank-you page: `apps/web/src/pages/thank-you/[orderId].astro`
- Funnel catalog: `apps/web/src/lib/config/funnels.ts`
- Asset seed data: `packages/db/src/seed.ts`

More detailed guides live in `docs/`.

The included pages use intentionally plain placeholder styling. They demonstrate the funnel wiring, not a finished sales-page design.

## Optional Providers

Leave optional provider env vars blank during local development. AgenticFunnel no-ops PostHog, Meta CAPI, Hyros, Mailgun, and MailerLite dispatch when their credentials are missing.

For production, configure the providers you actually need. See `docs/providers.md`.

## Deployment

Railway config is included for a separate web service and worker service. The app is also portable to any Node host with Postgres and S3-compatible storage.

See `docs/deploy-railway.md` and `PRODUCTION-CHECKLIST.md`.

## Verification

```bash
pnpm check:web
pnpm check:worker
pnpm build
pnpm test
```

GitHub Actions runs the same verification flow on pushes and pull requests.

## Contributing

Issues and pull requests are welcome. See `CONTRIBUTING.md` and `SECURITY.md` before submitting changes.

## License

MIT. See `LICENSE`.
