import { z } from "zod";

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.url().optional()
);

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PUBLIC_POSTHOG_KEY: z.string().optional().default(""),
  PUBLIC_POSTHOG_HOST: optionalUrl,
  PUBLIC_META_PIXEL_ID: z.string().optional().default(""),
  META_ACCESS_TOKEN: z.string().optional().default(""),
  META_TEST_EVENT_CODE: optionalNonEmpty,
  // Hyros server-side API key — used to POST orders to /api/v1.0/orders so
  // Hyros can complete the click → purchase attribution loop. Optional during
  // bring-up; if unset, the worker logs and skips dispatch (events stay in
  // outbox in `processing` state until set + redeployed).
  HYROS_API_KEY: optionalNonEmpty,
  MAILGUN_API_BASE: optionalUrl.default("https://api.mailgun.net"),
  MAILGUN_API_KEY: z.string().optional().default(""),
  MAILGUN_DOMAIN_TX: z.string().optional().default(""),
  // From address for transactional sends. Must be on MAILGUN_DOMAIN_TX.
  // Format: "Brand Name <no-reply@mailing.example.com>" or just "no-reply@mailing.example.com".
  MAILGUN_FROM_TX: z.string().optional().default(""),
  // Optional Reply-To. Set this to a real inbox a human reads (e.g. support).
  MAILGUN_REPLY_TO: z.preprocess((value) => (value === "" ? undefined : value), z.string().email().optional()),
  MAILERLITE_API_TOKEN: optionalNonEmpty,
  MAILERLITE_SHOP_ID: optionalNonEmpty,
  MAILERLITE_GROUPS_JSON: optionalNonEmpty,
  ASSET_BUCKET: z.string().optional().default(""),
  ASSET_REGION: z.string().optional().default(""),
  ASSET_ENDPOINT: optionalUrl,
  ASSET_ACCESS_KEY_ID: z.string().optional().default(""),
  ASSET_SECRET_ACCESS_KEY: z.string().optional().default(""),
  ASSET_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  PUBLIC_APP_URL: z.url(),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8788)
});

export const workerEnv = workerEnvSchema.parse(process.env);
