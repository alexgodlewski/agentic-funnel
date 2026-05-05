CREATE TYPE "consent_status" AS ENUM ('granted', 'denied');
CREATE TYPE "funnel_session_status" AS ENUM ('lead_captured', 'checkout_started', 'core_purchased', 'closed', 'expired', 'abandoned');
CREATE TYPE "checkout_attempt_status" AS ENUM ('initialized', 'requires_payment_method', 'processing', 'succeeded', 'failed');
CREATE TYPE "order_status" AS ENUM ('pending', 'awaiting_post_purchase', 'completed', 'failed', 'canceled');
CREATE TYPE "fulfillment_status" AS ENUM ('pending', 'queued', 'sent', 'failed');
CREATE TYPE "order_line_kind" AS ENUM ('core', 'order_bump', 'oto', 'downsell');
CREATE TYPE "payment_record_type" AS ENUM ('core', 'upsell');
CREATE TYPE "payment_record_status" AS ENUM ('requires_payment_method', 'requires_action', 'processing', 'succeeded', 'failed');
CREATE TYPE "offer_type" AS ENUM ('oto', 'downsell');
CREATE TYPE "offer_status" AS ENUM ('presented', 'accepted', 'declined', 'expired', 'charge_failed');
CREATE TYPE "outbox_channel" AS ENUM ('posthog', 'meta', 'mailgun', 'internal', 'mailerlite', 'hyros');
CREATE TYPE "outbox_status" AS ENUM ('pending', 'processing', 'delivered', 'failed', 'dead_letter');
CREATE TYPE "job_status" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead_letter');
CREATE TYPE "webhook_provider" AS ENUM ('stripe', 'mailgun');

CREATE TABLE "lead" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "normalized_email" text NOT NULL,
  "first_name" varchar(120),
  "last_name" varchar(120),
  "phone" varchar(40),
  "anonymous_id" varchar(255),
  "source_page" text NOT NULL,
  "funnel_key" varchar(120) NOT NULL,
  "utm" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "lead_normalized_email_idx" ON "lead" ("normalized_email");

CREATE TABLE "customer" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid NOT NULL REFERENCES "lead"("id") ON DELETE CASCADE,
  "stripe_customer_id" varchar(255),
  "posthog_distinct_id" varchar(255),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "customer_lead_id_idx" ON "customer" ("lead_id");
CREATE UNIQUE INDEX "customer_stripe_id_idx" ON "customer" ("stripe_customer_id");

CREATE TABLE "marketing_consent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid NOT NULL REFERENCES "lead"("id") ON DELETE CASCADE,
  "status" "consent_status" NOT NULL,
  "source_page" text NOT NULL,
  "ip_hash" varchar(128) NOT NULL,
  "user_agent_hash" varchar(128) NOT NULL,
  "captured_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "funnel_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid NOT NULL REFERENCES "lead"("id") ON DELETE CASCADE,
  "anonymous_id" varchar(255),
  "funnel_key" varchar(120) NOT NULL,
  "status" "funnel_session_status" NOT NULL DEFAULT 'lead_captured',
  "price_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "offer_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_touch" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_touch" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expires_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "checkout_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "funnel_session_id" uuid NOT NULL REFERENCES "funnel_session"("id") ON DELETE CASCADE,
  "stripe_payment_intent_id" varchar(255),
  "stripe_customer_id" varchar(255),
  "amount" integer NOT NULL,
  "currency" varchar(3) NOT NULL,
  "selected_order_bump" boolean NOT NULL DEFAULT false,
  "quote_snapshot" jsonb NOT NULL,
  "status" "checkout_attempt_status" NOT NULL DEFAULT 'initialized',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "recovered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "checkout_attempt_stripe_pi_idx" ON "checkout_attempt" ("stripe_payment_intent_id");

CREATE TABLE "order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "funnel_session_id" uuid NOT NULL REFERENCES "funnel_session"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE RESTRICT,
  "stripe_primary_payment_intent_id" varchar(255),
  "currency" varchar(3) NOT NULL,
  "total_amount" integer NOT NULL,
  "core_amount" integer NOT NULL,
  "order_bump_amount" integer NOT NULL DEFAULT 0,
  "status" "order_status" NOT NULL DEFAULT 'pending',
  "fulfillment_status" "fulfillment_status" NOT NULL DEFAULT 'pending',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expires_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "order_stripe_primary_pi_idx" ON "order" ("stripe_primary_payment_intent_id");

CREATE TABLE "asset_bundle" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sku" varchar(120) NOT NULL,
  "name" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "storage_key" text NOT NULL,
  "mime_type" text,
  "delivery_mode" varchar(40) NOT NULL DEFAULT 'signed_url',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "asset_bundle_sku_idx" ON "asset_bundle" ("sku");

CREATE TABLE "order_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "order"("id") ON DELETE CASCADE,
  "source_offer_instance_id" uuid,
  "kind" "order_line_kind" NOT NULL,
  "sku" varchar(120) NOT NULL,
  "name" text NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "unit_amount" integer NOT NULL,
  "total_amount" integer NOT NULL,
  "asset_bundle_id" uuid REFERENCES "asset_bundle"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "payment_record" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "order"("id") ON DELETE CASCADE,
  "offer_instance_id" uuid,
  "stripe_payment_intent_id" varchar(255) NOT NULL,
  "stripe_charge_id" varchar(255),
  "stripe_payment_method_id" varchar(255),
  "type" "payment_record_type" NOT NULL,
  "amount" integer NOT NULL,
  "currency" varchar(3) NOT NULL,
  "status" "payment_record_status" NOT NULL,
  "request_id" varchar(255),
  "error_code" varchar(120),
  "error_message" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "payment_record_stripe_pi_idx" ON "payment_record" ("stripe_payment_intent_id");
CREATE UNIQUE INDEX "payment_record_stripe_charge_idx" ON "payment_record" ("stripe_charge_id");

CREATE TABLE "post_purchase_offer_instance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "order"("id") ON DELETE CASCADE,
  "funnel_session_id" uuid NOT NULL REFERENCES "funnel_session"("id") ON DELETE CASCADE,
  "parent_offer_instance_id" uuid,
  "type" "offer_type" NOT NULL,
  "status" "offer_status" NOT NULL DEFAULT 'presented',
  "offer_token_hash" varchar(128),
  "token_issued_at" timestamptz,
  "decision_source" varchar(60),
  "offer_data" jsonb NOT NULL,
  "accepted_at" timestamptz,
  "declined_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "failed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "post_purchase_offer_instance_token_hash_idx" ON "post_purchase_offer_instance" ("offer_token_hash");

CREATE TABLE "email_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid REFERENCES "lead"("id") ON DELETE SET NULL,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "order"("id") ON DELETE SET NULL,
  "provider_event_id" varchar(255),
  "message_id" varchar(255),
  "email" text NOT NULL,
  "event_type" varchar(80) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "email_event_provider_event_idx" ON "email_event" ("provider_event_id");

CREATE TABLE "outbox_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "aggregate_type" varchar(120) NOT NULL,
  "aggregate_id" varchar(255) NOT NULL,
  "channel" "outbox_channel" NOT NULL,
  "event_name" varchar(120) NOT NULL,
  "dedupe_key" varchar(255) NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "outbox_status" NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "locked_at" timestamptz,
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "outbox_event_dedupe_idx" ON "outbox_event" ("dedupe_key");

CREATE TABLE "job_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_name" varchar(120) NOT NULL,
  "boss_job_id" uuid,
  "status" "job_status" NOT NULL DEFAULT 'pending',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error" text,
  "started_at" timestamptz,
  "ended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "job_log_boss_job_idx" ON "job_log" ("boss_job_id");

CREATE TABLE "webhook_receipt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" "webhook_provider" NOT NULL,
  "provider_event_id" varchar(255) NOT NULL,
  "event_type" varchar(120) NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX "webhook_receipt_provider_event_idx" ON "webhook_receipt" ("provider", "provider_event_id");

CREATE VIEW "ops_outbox_backlog" AS
SELECT
  channel,
  event_name,
  status,
  count(*) AS total,
  min(created_at) AS oldest_created_at
FROM "outbox_event"
GROUP BY channel, event_name, status;

CREATE VIEW "ops_open_funnels" AS
SELECT
  o.id AS order_id,
  o.status AS order_status,
  o.fulfillment_status,
  o.expires_at,
  fs.id AS funnel_session_id,
  fs.status AS funnel_status,
  l.email
FROM "order" o
JOIN "funnel_session" fs ON fs.id = o.funnel_session_id
JOIN "lead" l ON l.id = fs.lead_id
WHERE o.closed_at IS NULL;

CREATE VIEW "ops_failed_jobs" AS
SELECT
  job_name,
  status,
  error,
  count(*) AS total
FROM "job_log"
WHERE status IN ('failed', 'dead_letter')
GROUP BY job_name, status, error;
