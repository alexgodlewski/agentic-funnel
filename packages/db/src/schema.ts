import { relations, sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull()
};

export const consentStatusEnum = pgEnum("consent_status", ["granted", "denied"]);
export const funnelSessionStatusEnum = pgEnum("funnel_session_status", [
  "lead_captured",
  "checkout_started",
  "core_purchased",
  "closed",
  "expired",
  "abandoned"
]);
export const checkoutAttemptStatusEnum = pgEnum("checkout_attempt_status", [
  "initialized",
  "requires_payment_method",
  "processing",
  "succeeded",
  "failed"
]);
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "awaiting_post_purchase",
  "completed",
  "failed",
  "canceled"
]);
export const fulfillmentStatusEnum = pgEnum("fulfillment_status", ["pending", "queued", "sent", "failed"]);
export const orderLineKindEnum = pgEnum("order_line_kind", ["core", "order_bump", "oto", "downsell"]);
export const paymentRecordTypeEnum = pgEnum("payment_record_type", ["core", "upsell"]);
export const paymentRecordStatusEnum = pgEnum("payment_record_status", [
  "requires_payment_method",
  "requires_action",
  "processing",
  "succeeded",
  "failed"
]);
export const offerTypeEnum = pgEnum("offer_type", ["oto", "downsell"]);
export const offerStatusEnum = pgEnum("offer_status", ["presented", "accepted", "declined", "expired", "charge_failed"]);
export const outboxChannelEnum = pgEnum("outbox_channel", ["posthog", "meta", "mailgun", "internal", "mailerlite", "hyros"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "processing", "delivered", "failed", "dead_letter"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "succeeded", "failed", "dead_letter"]);
export const webhookProviderEnum = pgEnum("webhook_provider", ["stripe", "mailgun"]);

export const leads = pgTable(
  "lead",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    firstName: varchar("first_name", { length: 120 }),
    lastName: varchar("last_name", { length: 120 }),
    phone: varchar("phone", { length: 40 }),
    anonymousId: varchar("anonymous_id", { length: 255 }),
    sourcePage: text("source_page").notNull(),
    funnelKey: varchar("funnel_key", { length: 120 }).notNull(),
    utm: jsonb("utm").$type<Record<string, string>>().default(sql`'{}'::jsonb`).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps
  },
  (table) => ({
    normalizedEmailIdx: uniqueIndex("lead_normalized_email_idx").on(table.normalizedEmail)
  })
);

export const customers = pgTable(
  "customer",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    posthogDistinctId: varchar("posthog_distinct_id", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps
  },
  (table) => ({
    leadIdx: uniqueIndex("customer_lead_id_idx").on(table.leadId),
    stripeIdx: uniqueIndex("customer_stripe_id_idx").on(table.stripeCustomerId)
  })
);

export const marketingConsents = pgTable("marketing_consent", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  status: consentStatusEnum("status").notNull(),
  sourcePage: text("source_page").notNull(),
  ipHash: varchar("ip_hash", { length: 128 }).notNull(),
  userAgentHash: varchar("user_agent_hash", { length: 128 }).notNull(),
  capturedAt: timestamp("captured_at", { mode: "date", withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull()
});

export const funnelSessions = pgTable("funnel_session", {
  id: uuid("id").defaultRandom().primaryKey(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  anonymousId: varchar("anonymous_id", { length: 255 }),
  funnelKey: varchar("funnel_key", { length: 120 }).notNull(),
  status: funnelSessionStatusEnum("status").default("lead_captured").notNull(),
  priceSnapshot: jsonb("price_snapshot").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  offerSnapshot: jsonb("offer_snapshot").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  firstTouch: jsonb("first_touch").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  lastTouch: jsonb("last_touch").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  closedAt: timestamp("closed_at", { mode: "date", withTimezone: true }),
  ...timestamps
});

export const checkoutAttempts = pgTable(
  "checkout_attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    funnelSessionId: uuid("funnel_session_id")
      .notNull()
      .references(() => funnelSessions.id, { onDelete: "cascade" }),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    amount: integer("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    selectedOrderBump: boolean("selected_order_bump").default(false).notNull(),
    quoteSnapshot: jsonb("quote_snapshot").$type<Record<string, unknown>>().notNull(),
    status: checkoutAttemptStatusEnum("status").default("initialized").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    recoveredAt: timestamp("recovered_at", { mode: "date", withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    stripePiIdx: uniqueIndex("checkout_attempt_stripe_pi_idx").on(table.stripePaymentIntentId)
  })
);

export const orders = pgTable(
  "order",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    funnelSessionId: uuid("funnel_session_id")
      .notNull()
      .references(() => funnelSessions.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    stripePrimaryPaymentIntentId: varchar("stripe_primary_payment_intent_id", { length: 255 }),
    currency: varchar("currency", { length: 3 }).notNull(),
    totalAmount: integer("total_amount").notNull(),
    coreAmount: integer("core_amount").notNull(),
    orderBumpAmount: integer("order_bump_amount").default(0).notNull(),
    status: orderStatusEnum("status").default("pending").notNull(),
    fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status").default("pending").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    closedAt: timestamp("closed_at", { mode: "date", withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    stripePrimaryPiIdx: uniqueIndex("order_stripe_primary_pi_idx").on(table.stripePrimaryPaymentIntentId)
  })
);

export const assetBundles = pgTable(
  "asset_bundle",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sku: varchar("sku", { length: 120 }).notNull(),
    name: text("name").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type"),
    deliveryMode: varchar("delivery_mode", { length: 40 }).default("signed_url").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestamps
  },
  (table) => ({
    skuIdx: uniqueIndex("asset_bundle_sku_idx").on(table.sku)
  })
);

export const orderLines = pgTable("order_line", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  sourceOfferInstanceId: uuid("source_offer_instance_id"),
  kind: orderLineKindEnum("kind").notNull(),
  sku: varchar("sku", { length: 120 }).notNull(),
  name: text("name").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  unitAmount: integer("unit_amount").notNull(),
  totalAmount: integer("total_amount").notNull(),
  assetBundleId: uuid("asset_bundle_id").references(() => assetBundles.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  ...timestamps
});

export const paymentRecords = pgTable(
  "payment_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    offerInstanceId: uuid("offer_instance_id"),
    stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }).notNull(),
    stripeChargeId: varchar("stripe_charge_id", { length: 255 }),
    stripePaymentMethodId: varchar("stripe_payment_method_id", { length: 255 }),
    type: paymentRecordTypeEnum("type").notNull(),
    amount: integer("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: paymentRecordStatusEnum("status").notNull(),
    requestId: varchar("request_id", { length: 255 }),
    errorCode: varchar("error_code", { length: 120 }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps
  },
  (table) => ({
    stripePiIdx: uniqueIndex("payment_record_stripe_pi_idx").on(table.stripePaymentIntentId),
    stripeChargeIdx: uniqueIndex("payment_record_stripe_charge_idx").on(table.stripeChargeId)
  })
);

export const postPurchaseOfferInstances = pgTable(
  "post_purchase_offer_instance",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    funnelSessionId: uuid("funnel_session_id")
      .notNull()
      .references(() => funnelSessions.id, { onDelete: "cascade" }),
    parentOfferInstanceId: uuid("parent_offer_instance_id"),
    type: offerTypeEnum("type").notNull(),
    status: offerStatusEnum("status").default("presented").notNull(),
    offerTokenHash: varchar("offer_token_hash", { length: 128 }),
    tokenIssuedAt: timestamp("token_issued_at", { mode: "date", withTimezone: true }),
    decisionSource: varchar("decision_source", { length: 60 }),
    offerData: jsonb("offer_data").$type<Record<string, unknown>>().notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true }),
    declinedAt: timestamp("declined_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    failedAt: timestamp("failed_at", { mode: "date", withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("post_purchase_offer_instance_token_hash_idx").on(table.offerTokenHash)
  })
);

export const emailEvents = pgTable(
  "email_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    providerEventId: varchar("provider_event_id", { length: 255 }),
    messageId: varchar("message_id", { length: 255 }),
    email: text("email").notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    providerEventIdx: uniqueIndex("email_event_provider_event_idx").on(table.providerEventId)
  })
);

export const outboxEvents = pgTable(
  "outbox_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aggregateType: varchar("aggregate_type", { length: 120 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 255 }).notNull(),
    channel: outboxChannelEnum("channel").notNull(),
    eventName: varchar("event_name", { length: 120 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    availableAt: timestamp("available_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { mode: "date", withTimezone: true }),
    processedAt: timestamp("processed_at", { mode: "date", withTimezone: true }),
    ...timestamps
  },
  (table) => ({
    dedupeIdx: uniqueIndex("outbox_event_dedupe_idx").on(table.dedupeKey)
  })
);

export const jobLogs = pgTable(
  "job_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobName: varchar("job_name", { length: 120 }).notNull(),
    bossJobId: uuid("boss_job_id"),
    status: jobStatusEnum("status").default("pending").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    bossJobIdx: uniqueIndex("job_log_boss_job_idx").on(table.bossJobId)
  })
);

export const webhookReceipts = pgTable(
  "webhook_receipt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: webhookProviderEnum("provider").notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { mode: "date", withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull()
  },
  (table) => ({
    providerEventIdx: uniqueIndex("webhook_receipt_provider_event_idx").on(table.provider, table.providerEventId)
  })
);

export const leadRelations = relations(leads, ({ many, one }) => ({
  consents: many(marketingConsents),
  funnelSessions: many(funnelSessions),
  customer: one(customers, {
    fields: [leads.id],
    references: [customers.leadId]
  })
}));

export const customerRelations = relations(customers, ({ one, many }) => ({
  lead: one(leads, {
    fields: [customers.leadId],
    references: [leads.id]
  }),
  orders: many(orders)
}));

export const orderRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id]
  }),
  funnelSession: one(funnelSessions, {
    fields: [orders.funnelSessionId],
    references: [funnelSessions.id]
  }),
  lines: many(orderLines),
  payments: many(paymentRecords),
  offers: many(postPurchaseOfferInstances)
}));
