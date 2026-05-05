# Optional Providers

AgenticFunnel works locally without analytics, ad attribution, email, or marketing automation credentials.

## PostHog

Set `PUBLIC_POSTHOG_KEY` and optionally `PUBLIC_POSTHOG_HOST`. Use a first-party proxy in production if you care about ad-blocker resistance.

## Meta Pixel And CAPI

Set `PUBLIC_META_PIXEL_ID` for browser events and `META_ACCESS_TOKEN` for server-side Conversions API dispatch.

## Mailgun

Set `MAILGUN_API_KEY`, `MAILGUN_DOMAIN_TX`, and `MAILGUN_FROM_TX` to send real fulfillment emails. When missing, mail jobs no-op.

## MailerLite

Set `MAILERLITE_API_TOKEN`, `MAILERLITE_SHOP_ID`, and `MAILERLITE_GROUPS_JSON` to sync subscribers, carts, orders, and segmentation groups.

## Hyros

Set browser and worker Hyros env vars only if you use Hyros attribution.
