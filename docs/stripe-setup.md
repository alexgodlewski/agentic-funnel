# Stripe Setup

## Products And Prices

Create test-mode Products and recurring-independent one-time Prices for:

- CORE: your main digital product.
- ORDER_BUMP_1: optional checkout add-on.
- ORDER_BUMP_2: optional checkout add-on.
- OTO: post-purchase upsell.
- DOWNSELL: lower-price post-purchase offer.

For each Stripe Product, add metadata:

```text
r2_key=starter-funnel/core/starter-playbook.pdf
```

Use the object key that should be delivered when that product is purchased.

## Sync Prices

After filling `.env`, run:

```bash
pnpm --filter @agentic-funnel/web sync:stripe
```

This updates `apps/web/src/lib/config/funnels.generated.ts`.

## Webhooks

Create a webhook endpoint:

```text
https://your-domain.com/api/webhooks/stripe
```

Subscribe to:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`

Set the signing secret as `STRIPE_TEST_WEBHOOK_SECRET` or `STRIPE_LIVE_WEBHOOK_SECRET`.

## Apple Pay Domains

Do not commit a real Apple Pay domain-association file to the starter. Add your own `/.well-known/apple-developer-merchantid-domain-association` file only in the deployment that uses your Stripe account and verified domain.
