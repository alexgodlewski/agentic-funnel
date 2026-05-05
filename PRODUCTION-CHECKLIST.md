# AgenticFunnel Launch Checklist

Use this checklist before publishing a real funnel. It is a starter checklist, not legal,
tax, or compliance advice.

## Stripe

- [ ] Create test Products and Prices for CORE, order bumps, OTO, and downsell.
- [ ] Add each Product metadata key `r2_key` matching your asset object key.
- [ ] Fill `STRIPE_TEST_*` env vars and run `pnpm --filter @agentic-funnel/web sync:stripe`.
- [ ] Create a Stripe webhook endpoint at `https://your-domain.com/api/webhooks/stripe`.
- [ ] Subscribe to `payment_intent.succeeded` and `payment_intent.payment_failed`.
- [ ] Test cards, wallets, and any local payment methods you enable.
- [ ] Repeat setup in live mode, then switch `STRIPE_MODE=live`.

## Product And Funnel

- [ ] Replace the starter landing page with your real product story.
- [ ] Update `apps/web/src/lib/config/funnels.ts` with your SKUs, copy, assets, and offer slots.
- [ ] Replace placeholder assets in `local-assets/` or upload real files to S3/R2.
- [ ] Replace OTO, downsell, checkout, and thank-you copy with your own offer.
- [ ] Add real testimonials, guarantee text, support email, and brand details.

## Infrastructure

- [ ] Provision Postgres and set `DATABASE_URL`.
- [ ] Run Drizzle migrations with `pnpm db:push` or a reviewed migration workflow.
- [ ] Provision S3-compatible storage and set `ASSET_*` env vars.
- [ ] Run `pnpm db:seed:assets` after asset keys are final.
- [ ] Deploy the web service and worker service separately.
- [ ] Configure health checks for `/api/health` and the worker health port.

## Optional Providers

- [ ] PostHog browser/server analytics.
- [ ] Meta Pixel and Conversions API.
- [ ] Mailgun transactional fulfillment email.
- [ ] MailerLite subscriber, cart, order, and segmentation sync.
- [ ] Hyros attribution.

## Legal And Operations

- [ ] Replace `/terms`, `/privacy`, and `/company` with lawyer-reviewed copy.
- [ ] Add cookie consent if using analytics or advertising pixels.
- [ ] Confirm refund, tax, invoice, and customer support obligations.
- [ ] Add monitoring for failed webhooks, dead-letter outbox events, and worker crashes.
- [ ] Rotate secrets before launch if they were shared during setup.

## Smoke Tests

- [ ] Lead capture creates a lead and redirects to checkout.
- [ ] Checkout succeeds with core only.
- [ ] Checkout succeeds with each order bump combination.
- [ ] OTO accept creates an order line and fulfillment.
- [ ] OTO decline routes to downsell.
- [ ] Downsell accept and decline both end at thank-you.
- [ ] Thank-you page downloads work and enforce token limits.
- [ ] Fulfillment email includes all purchased assets.
