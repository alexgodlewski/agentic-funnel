# Customize Your Funnel

AgenticFunnel is meant to be edited. The starter copy is only scaffolding.

## Main Files

- `apps/web/src/pages/index.astro`: landing page.
- `apps/web/src/pages/checkout.astro`: buyer details, order bumps, and payment UI.
- `apps/web/src/pages/oto/[token].astro`: post-purchase upsell.
- `apps/web/src/pages/downsell/[token].astro`: lower-friction offer after OTO decline.
- `apps/web/src/pages/thank-you/[orderId].astro`: downloads and order confirmation.
- `apps/web/src/lib/config/funnels.ts`: SKUs, copy, bump display data, and asset overrides.
- `packages/db/src/seed.ts`: local asset bundle seed data.

## Funnel Catalog

Stripe owns Product names, Prices, currencies, and Product metadata `r2_key`.
`funnels.ts` owns the offer structure that is unique to your funnel:

- Internal SKUs.
- Which Stripe slots are enabled.
- Order bump badges, descriptions, bullets, and images.
- Multi-file asset overrides for a single purchased line item.
- The default funnel key, currently `starter-funnel`.

Run `pnpm --filter @agentic-funnel/web sync:stripe` after changing Stripe Price IDs.

## Asset Delivery

For local development, `compose.yaml` copies `local-assets/` into MinIO. The committed files are neutral placeholders only. Replace them with your own fulfillment assets, then match your asset paths to the values in `funnels.ts` and `packages/db/src/seed.ts`.

The public starter uses deliberately plain CSS in `apps/web/src/styles/funnel.css`. Replace it with your own landing page and brand system before promoting an offer.

For production, upload the same object keys to S3, Cloudflare R2, DigitalOcean Spaces, or another S3-compatible provider.

## Legal Pages

Replace `/terms`, `/privacy`, and `/company` before launch. The included pages are placeholders only.
