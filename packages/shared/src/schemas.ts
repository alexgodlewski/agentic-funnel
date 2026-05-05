import { z } from "zod";

import {
  checkoutAttemptStatusSchema,
  consentStatusSchema,
  offerStatusSchema,
  offerTypeSchema,
  orderLineKindSchema,
  outboxChannelSchema,
  paymentRecordStatusSchema,
  trackingEventNameSchema
} from "./events";

const primitiveJsonSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([primitiveJsonSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

export const utmSchema = z
  .object({
    source: z.string().optional(),
    medium: z.string().optional(),
    campaign: z.string().optional(),
    term: z.string().optional(),
    content: z.string().optional()
  })
  .catchall(z.string());

export const leadIdentitySchema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  anonymousId: z.string().trim().min(1).max(255).optional(),
  sourcePage: z.string().trim().min(1),
  funnelKey: z.string().trim().min(1),
  utm: utmSchema.optional()
});

export const marketingConsentSchema = z.object({
  status: consentStatusSchema,
  sourcePage: z.string().trim().min(1),
  ipHash: z.string().trim().min(10),
  userAgentHash: z.string().trim().min(10),
  timestamp: z.string().datetime()
});

export const leadCaptureInputSchema = z.object({
  identity: leadIdentitySchema,
  consent: marketingConsentSchema
});

export const checkoutQuoteItemSchema = z.object({
  kind: orderLineKindSchema,
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  quantity: z.number().int().positive(),
  unitAmount: z.number().int().nonnegative(),
  totalAmount: z.number().int().nonnegative(),
  // Per-line metadata. Reserved keys: `r2Key` (Stripe Product metadata.r2_key),
  // used by the fulfillment worker to sign a download URL.
  metadata: z.record(z.string(), jsonValueSchema).default({})
});

export const checkoutDiscountSchema = z.object({
  promoCode: z.string().trim().min(1),
  appliesToSku: z.string().trim().min(1),
  percentOff: z.number().min(0).max(100),
  amount: z.number().int().nonnegative()
});

export const checkoutQuoteSchema = z.object({
  funnelKey: z.string().trim().min(1),
  currency: z.string().length(3).transform((value) => value.toLowerCase()),
  subtotalAmount: z.number().int().nonnegative(),
  totalAmount: z.number().int().nonnegative(),
  items: z.array(checkoutQuoteItemSchema).min(1),
  orderBumpSelected: z.boolean(),
  // Set when a recovery promo code is applied. Affects only one item line
  // (currently always CORE). Server is source of truth — client renders
  // whatever the server returns.
  discount: checkoutDiscountSchema.nullable().optional(),
  offerSnapshot: z.object({
    oto: z.object({
      sku: z.string(),
      name: z.string(),
      unitAmount: z.number().int().nonnegative()
    }),
    downsell: z.object({
      sku: z.string(),
      name: z.string(),
      unitAmount: z.number().int().nonnegative()
    })
  })
});

export const checkoutIntentInputSchema = z.object({
  leadId: z.string().uuid(),
  funnelSessionId: z.string().uuid(),
  funnelKey: z.string().trim().min(1),
  /** Set of catalog SKUs the buyer toggled on. Server is source of truth for amounts. */
  selectedBumpSkus: z.array(z.string().trim().min(1)).default([]),
  checkoutAttemptId: z.string().uuid().optional(),
  /** Recovery promo code from `?promo=` URL param. Validated server-side. */
  promoCode: z.string().trim().toUpperCase().optional()
});

export const checkoutIntentResponseSchema = z.object({
  checkoutAttemptId: z.string().uuid(),
  paymentIntentId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  quote: checkoutQuoteSchema,
  metaEventIds: z
    .object({
      initiateCheckout: z.string().trim().min(1)
    })
    .optional()
});

export const checkoutStatusResponseSchema = z.object({
  checkoutAttemptId: z.string().uuid(),
  status: checkoutAttemptStatusSchema,
  paymentIntentId: z.string().trim().min(1).optional(),
  orderId: z.string().uuid().optional(),
  nextStep: z.enum(["oto", "thank_you"]).optional(),
  nextUrl: z.string().trim().min(1).optional()
});

export const demoCheckoutConfirmInputSchema = z.object({
  checkoutAttemptId: z.string().uuid()
});

export const offerTokenPayloadSchema = z.object({
  version: z.literal(1),
  orderId: z.string().uuid(),
  funnelSessionId: z.string().uuid(),
  offerInstanceId: z.string().uuid(),
  offerType: offerTypeSchema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

export const offerDecisionResponseSchema = z.object({
  status: offerStatusSchema,
  nextStep: z.enum(["downsell", "thank_you"]),
  nextToken: z.string().optional(),
  orderId: z.string().uuid(),
  metaEventId: z.string().trim().min(1).optional(),
  purchaseMetaEventId: z.string().trim().min(1).optional(),
  purchaseValue: z.number().nonnegative().optional(),
  purchaseCurrency: z.string().length(3).optional(),
  // Order-line breakdown of the Purchase event so the client can attach
  // `content_ids` / `contents` to the Meta Purchase pixel — without these,
  // upsell-flow Purchases don't attribute back to the correct catalog SKUs.
  purchaseContents: z
    .array(
      z.object({
        id: z.string().min(1),
        quantity: z.number().int().positive(),
        item_price: z.number().nonnegative()
      })
    )
    .optional(),
  purchaseNumItems: z.number().int().nonnegative().optional(),
  // Set when the buyer's saved PaymentMethod is single-use (BLIK / P24) and
  // can't be charged off_session. Client mounts a method-specific UI (BLIK
  // popup or P24 redirect) and calls Stripe.js with the returned clientSecret.
  // Webhook (`payment_intent.succeeded` with metadata.flow="offer") finalizes
  // the offer once the bank confirms.
  paymentAction: z
    .object({
      method: z.enum(["blik", "p24"]),
      clientSecret: z.string().trim().min(1),
      paymentIntentId: z.string().trim().min(1)
    })
    .optional()
});

export const trackingEventSchema = z.object({
  event: trackingEventNameSchema,
  eventId: z.string().trim().min(1),
  distinctId: z.string().trim().min(1),
  anonymousId: z.string().trim().min(1).optional(),
  timestamp: z.string().datetime(),
  properties: z.record(z.string(), jsonValueSchema).default({}),
  // PostHog person properties. Merged into the event's $set / $set_once on
  // dispatch so identifying info travels with the event that creates it.
  set: z.record(z.string(), jsonValueSchema).optional(),
  setOnce: z.record(z.string(), jsonValueSchema).optional()
});

// Inline HTML + text body. We don't use Mailgun-side templates anymore —
// everything renders in the worker so the copy lives in version control next
// to the code that builds the payload.
export const mailJobPayloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().trim().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  tags: z.array(z.string()).default([])
});

// Hyros order payload — what we POST to https://api.hyros.com/api/v1.0/orders.
// Hyros requires at least one of `email` or `phoneNumbers` to attribute the
// purchase back to a tracked click. Items must have a name + price each.
export const hyrosOrderItemSchema = z.object({
  name: z.string().trim().min(1),
  price: z.number().nonnegative(),
  quantity: z.number().int().positive().optional(),
  externalId: z.string().optional(),
  tag: z.string().optional(),
  categoryName: z.string().optional()
});

export const hyrosOrderPayloadSchema = z
  .object({
    email: z.string().email().optional(),
    phoneNumbers: z.array(z.string().min(1)).optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    leadIps: z.array(z.string().min(1)).optional(),
    orderId: z.string().min(1).optional(),
    cartId: z.string().min(1).optional(),
    date: z.string().datetime().optional(),
    currency: z.string().min(1).optional(),
    priceFormat: z.enum(["DECIMAL", "INTEGER"]).default("DECIMAL"),
    shippingCost: z.number().nonnegative().optional(),
    taxes: z.number().nonnegative().optional(),
    orderDiscount: z.number().nonnegative().optional(),
    items: z.array(hyrosOrderItemSchema).min(1)
  })
  .refine(
    (data) => Boolean(data.email) || (data.phoneNumbers && data.phoneNumbers.length > 0),
    { message: "Hyros requires at least one of `email` or `phoneNumbers`" }
  );

// Hyros lead payload — POSTed to https://api.hyros.com/api/v1.0/leads when a
// new lead is captured. Same identity-matching rule as orders: at least one of
// `email` or `phoneNumbers`. `leadIps` lets Hyros stitch the lead back to the
// click that brought them in even before they buy.
export const hyrosLeadPayloadSchema = z
  .object({
    email: z.string().email().optional(),
    phoneNumbers: z.array(z.string().min(1)).optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    leadIps: z.array(z.string().min(1)).optional(),
    date: z.string().datetime().optional(),
    tags: z.array(z.string().min(1)).optional()
  })
  .refine(
    (data) => Boolean(data.email) || (data.phoneNumbers && data.phoneNumbers.length > 0),
    { message: "Hyros requires at least one of `email` or `phoneNumbers`" }
  );

export const outboxEventPayloadSchema = z.object({
  channel: outboxChannelSchema,
  eventName: z.string().trim().min(1),
  payload: z.record(z.string(), jsonValueSchema),
  dedupeKey: z.string().trim().min(1)
});

export const orderAggregateSchema = z.object({
  orderId: z.string().uuid(),
  funnelSessionId: z.string().uuid(),
  customerId: z.string().uuid(),
  currency: z.string().length(3),
  totalAmount: z.number().int().nonnegative(),
  lines: z.array(checkoutQuoteItemSchema),
  paymentStatus: paymentRecordStatusSchema
});

export type LeadIdentity = z.infer<typeof leadIdentitySchema>;
export type MarketingConsent = z.infer<typeof marketingConsentSchema>;
export type CheckoutQuote = z.infer<typeof checkoutQuoteSchema>;
export type OrderAggregate = z.infer<typeof orderAggregateSchema>;
export type OfferTokenPayload = z.infer<typeof offerTokenPayloadSchema>;
export type TrackingEvent = z.infer<typeof trackingEventSchema>;
export type MailJobPayload = z.infer<typeof mailJobPayloadSchema>;
export type HyrosOrderPayload = z.infer<typeof hyrosOrderPayloadSchema>;
export type HyrosLeadPayload = z.infer<typeof hyrosLeadPayloadSchema>;
export type CheckoutStatusResponse = z.infer<typeof checkoutStatusResponseSchema>;
