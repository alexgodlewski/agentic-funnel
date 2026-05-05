import { z } from "zod";

import { resolveStripeEnv } from "./stripe-env";

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional()
);

const webEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PUBLIC_APP_URL: z.url(),
  STRIPE_SECRET_KEY: z.string().min(1),
  PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_API_VERSION: z.string().default("2026-02-25.clover"),
  // Slot → Stripe Price ID. Each is optional; missing slot = product hidden.
  // Resolved at build time by `pnpm sync:stripe` into funnels.generated.ts.
  STRIPE_PRICE_CORE: z.string().min(1).optional(),
  STRIPE_PRICE_ORDER_BUMP_1: z.string().min(1).optional(),
  STRIPE_PRICE_ORDER_BUMP_2: z.string().min(1).optional(),
  STRIPE_PRICE_OTO: z.string().min(1).optional(),
  STRIPE_PRICE_DOWNSELL: z.string().min(1).optional(),
  PUBLIC_POSTHOG_KEY: z.string().optional().default(""),
  PUBLIC_POSTHOG_HOST: optionalUrl,
  PUBLIC_META_PIXEL_ID: z.string().optional().default(""),
  META_ACCESS_TOKEN: z.string().optional().default(""),
  META_TEST_EVENT_CODE: optionalNonEmpty,
  // Hyros first-party tracking domain (CNAME to Hyros). Both vars are public —
  // they get inlined into the browser bundle. Leave optional for dev/staging
  // where Hyros isn't configured.
  PUBLIC_HYROS_TRACKING_DOMAIN: optionalNonEmpty,
  PUBLIC_HYROS_PROPERTY_HASH: optionalNonEmpty,
  APP_SIGNING_SECRET: z.string().min(32),
  POST_PURCHASE_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  ASSET_BUCKET: optionalNonEmpty,
  ASSET_REGION: optionalNonEmpty,
  ASSET_ENDPOINT: optionalUrl,
  ASSET_ACCESS_KEY_ID: optionalNonEmpty,
  ASSET_SECRET_ACCESS_KEY: optionalNonEmpty,
  ASSET_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(300)
});

export const webEnv = webEnvSchema.parse({
  ...process.env,
  ...resolveStripeEnv(process.env)
});
