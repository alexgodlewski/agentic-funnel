import { z } from "zod";

// Aligned with PostHog's official ecommerce events spec so CDP destination
// templates and Revenue Analytics work without manual mapping.
// https://posthog.com/docs/data/ecommerce-events-spec
export const trackingEventNames = [
  // PostHog ecommerce spec — Title Case names, spec-defined property shapes.
  "Product Viewed",
  "Product Added",
  "Product Removed",
  "Cart Viewed",
  "Checkout Started",
  "Payment Info Entered",
  "Order Completed",
  "Order Updated",
  "Order Refunded",
  "Order Cancelled",
  "Coupon Entered",
  "Coupon Applied",
  "Coupon Denied",
  // Funnel-specific events — keep custom names so they're easy to filter in
  // PostHog and don't get confused with spec events.
  "Lead Started",
  "Lead Submitted",
  "Offer Declined",
  "Order_Fully_Completed",
  "Funnel Expired",
  "Fulfillment Sent",
  "Section Seen"
] as const;

export const trackingEventNameSchema = z.enum(trackingEventNames);

export const outboxChannelNames = ["posthog", "meta", "mailgun", "mailerlite", "hyros", "internal"] as const;
export const outboxChannelSchema = z.enum(outboxChannelNames);

export const outboxStatusNames = ["pending", "processing", "delivered", "failed", "dead_letter"] as const;
export const outboxStatusSchema = z.enum(outboxStatusNames);

export const offerTypeNames = ["oto", "downsell"] as const;
export const offerTypeSchema = z.enum(offerTypeNames);

export const offerStatusNames = ["presented", "accepted", "declined", "expired", "charge_failed"] as const;
export const offerStatusSchema = z.enum(offerStatusNames);

export const consentStatusNames = ["granted", "denied"] as const;
export const consentStatusSchema = z.enum(consentStatusNames);

export const orderLineKindNames = ["core", "order_bump", "oto", "downsell"] as const;
export const orderLineKindSchema = z.enum(orderLineKindNames);

export const paymentRecordTypeNames = ["core", "upsell"] as const;
export const paymentRecordTypeSchema = z.enum(paymentRecordTypeNames);

export const paymentRecordStatusNames = [
  "requires_payment_method",
  "requires_action",
  "processing",
  "succeeded",
  "failed"
] as const;
export const paymentRecordStatusSchema = z.enum(paymentRecordStatusNames);

export const checkoutAttemptStatusNames = [
  "initialized",
  "requires_payment_method",
  "processing",
  "succeeded",
  "failed"
] as const;
export const checkoutAttemptStatusSchema = z.enum(checkoutAttemptStatusNames);

export const orderStatusNames = ["pending", "awaiting_post_purchase", "completed", "failed", "canceled"] as const;
export const orderStatusSchema = z.enum(orderStatusNames);

export const fulfillmentStatusNames = ["pending", "queued", "sent", "failed"] as const;
export const fulfillmentStatusSchema = z.enum(fulfillmentStatusNames);

export const funnelSessionStatusNames = [
  "lead_captured",
  "checkout_started",
  "core_purchased",
  "closed",
  "expired",
  "abandoned"
] as const;
export const funnelSessionStatusSchema = z.enum(funnelSessionStatusNames);

export const webhookProviderNames = ["stripe"] as const;
export const webhookProviderSchema = z.enum(webhookProviderNames);

export type TrackingEventName = z.infer<typeof trackingEventNameSchema>;
export type OutboxChannel = z.infer<typeof outboxChannelSchema>;
export type OfferType = z.infer<typeof offerTypeSchema>;
