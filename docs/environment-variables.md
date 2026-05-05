# Environment Variables

Copy `.env.example` to `.env`.

## Required Locally

- `DATABASE_URL`: local Postgres URL from `compose.yaml`.
- `PUBLIC_APP_URL`: usually `http://localhost:4321`.
- `APP_SIGNING_SECRET`: at least 32 characters.
- `ASSET_*`: local MinIO settings are already in `.env.example`.

## Required For Real Payments

- `STRIPE_MODE`
- `STRIPE_API_VERSION`
- `STRIPE_TEST_SECRET_KEY`
- `STRIPE_TEST_PUBLISHABLE_KEY`
- `STRIPE_TEST_WEBHOOK_SECRET`
- `STRIPE_TEST_PRICE_CORE`

Order bump, OTO, and downsell Price IDs are optional. Missing slots are hidden or skipped.

## Optional Providers

These can stay blank locally:

- `PUBLIC_POSTHOG_KEY`
- `PUBLIC_META_PIXEL_ID`
- `META_ACCESS_TOKEN`
- `PUBLIC_HYROS_TRACKING_DOMAIN`
- `PUBLIC_HYROS_PROPERTY_HASH`
- `HYROS_API_KEY`
- `MAILGUN_API_KEY`
- `MAILERLITE_API_TOKEN`

When blank, dispatchers return without sending provider requests.
