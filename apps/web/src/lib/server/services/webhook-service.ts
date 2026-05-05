import { and, eq } from "drizzle-orm";
import Stripe from "stripe";

import { schema } from "@agentic-funnel/db";

import { db } from "../db";
import { finalizeSuccessfulCorePayment } from "./core-payment-service";
import { finalizeOfferFromPaymentIntent } from "./offer-service";
import { buildTrackingOutboxEvent, enqueueOutboxEvents } from "./outbox-service";

async function recordWebhookReceipt(provider: "stripe", providerEventId: string, eventType: string, payload: Record<string, unknown>) {
  const [existing] = await db
    .select()
    .from(schema.webhookReceipts)
    .where(
      and(
        eq(schema.webhookReceipts.provider, provider),
        eq(schema.webhookReceipts.providerEventId, providerEventId)
      )
    )
    .limit(1);

  if (existing) {
    return false;
  }

  await db.insert(schema.webhookReceipts).values({
    provider,
    providerEventId,
    eventType,
    payload
  });

  return true;
}

export async function handleStripeEvent(event: Stripe.Event) {
  const isNew = await recordWebhookReceipt("stripe", event.id, event.type, event.data.object as unknown as Record<string, unknown>);
  if (!isNew) {
    return;
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.payment_failed":
      await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    case "charge.refunded":
      await handleChargeRefunded(event.data.object as Stripe.Charge);
      break;
    default:
      break;
  }

  await db
    .update(schema.webhookReceipts)
    .set({
      processedAt: new Date()
    })
    .where(eq(schema.webhookReceipts.providerEventId, event.id));
}

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const flow = paymentIntent.metadata.flow;

  if (flow === "core") {
    await finalizeSuccessfulCorePayment({
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      paymentMethodId:
        typeof paymentIntent.payment_method === "string" ? paymentIntent.payment_method : null,
      chargeId: paymentIntent.latest_charge ? String(paymentIntent.latest_charge) : null
    });
    return;
  }

  if (flow === "offer") {
    // OTO / Downsell PI succeeded. Three paths land here:
    //  1. BLIK / P24 — server returned a deferred PI to the client; bank
    //     confirmed async; we finalize fully here (no synchronous fallback).
    //  2. Card off_session that hit 3DS / requires_action and completed later.
    //  3. Card off_session that succeeded synchronously — finalizeAcceptedOffer
    //     already ran; finalizeOfferFromPaymentIntent is idempotent.
    await finalizeOfferFromPaymentIntent({
      id: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      payment_method:
        typeof paymentIntent.payment_method === "string" ? paymentIntent.payment_method : null,
      metadata: paymentIntent.metadata as Record<string, string | undefined>
    });
    return;
  }
}

async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
  const flow = paymentIntent.metadata.flow;

  if (flow === "core") {
    await db
      .update(schema.checkoutAttempts)
      .set({
        status: "failed",
        updatedAt: new Date()
      })
      .where(eq(schema.checkoutAttempts.stripePaymentIntentId, paymentIntent.id));

    await emitOrderCancelled({
      paymentIntent,
      reason: paymentIntent.last_payment_error?.code ?? "payment_failed"
    });
    return;
  }

  if (flow === "offer") {
    await finalizeAsyncOfferFailure(paymentIntent);
    return;
  }
}

async function finalizeAsyncOfferFailure(paymentIntent: Stripe.PaymentIntent) {
  const offerInstanceId = paymentIntent.metadata.offerInstanceId;
  if (!offerInstanceId) return;

  await db
    .update(schema.postPurchaseOfferInstances)
    .set({
      status: "charge_failed",
      failedAt: new Date(),
      decisionSource: paymentIntent.last_payment_error?.code ?? "webhook_failed",
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.postPurchaseOfferInstances.id, offerInstanceId),
        eq(schema.postPurchaseOfferInstances.status, "presented")
      )
    );
}

async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) return;

  const [paymentRecord] = await db
    .select()
    .from(schema.paymentRecords)
    .where(eq(schema.paymentRecords.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  if (!paymentRecord) return;

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, paymentRecord.orderId))
    .limit(1);
  if (!order) return;

  const [customer] = await db
    .select({ leadId: schema.customers.leadId })
    .from(schema.customers)
    .where(eq(schema.customers.id, order.customerId))
    .limit(1);
  const [lead] = customer
    ? await db
        .select({ id: schema.leads.id, anonymousId: schema.leads.anonymousId })
        .from(schema.leads)
        .where(eq(schema.leads.id, customer.leadId))
        .limit(1)
    : [undefined];
  const distinctId = lead?.anonymousId ?? (lead ? `lead:${lead.id}` : `order:${order.id}`);

  // Stripe sends one charge.refunded event per refund (partial or full).
  // Dedupe on the latest refund id so partial refunds don't collide.
  const latestRefund = charge.refunds?.data?.[0];
  const refundId = latestRefund?.id ?? `${charge.id}:${charge.amount_refunded}`;
  const refundAmountUnits = (latestRefund?.amount ?? charge.amount_refunded) / 100;

  await db.transaction(async (tx) => {
    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "order",
        aggregateId: order.id,
        dedupeKey: `posthog:Order Refunded:${refundId}`,
        event: {
          event: "Order Refunded",
          eventId: `Order Refunded:${refundId}`,
          distinctId,
          anonymousId: lead?.anonymousId ?? undefined,
          timestamp: new Date().toISOString(),
          properties: {
            order_id: order.id,
            funnel_session_id: order.funnelSessionId,
            funnel_key:
              order.metadata && typeof order.metadata === "object"
                ? ((order.metadata as { funnelKey?: unknown }).funnelKey as string | undefined) ?? null
                : null,
            total: refundAmountUnits,
            currency: charge.currency,
            stripe_refund_id: latestRefund?.id ?? null,
            stripe_charge_id: charge.id
          }
        }
      })
    ]);
  });
}

async function emitOrderCancelled(input: {
  paymentIntent: Stripe.PaymentIntent;
  reason: string;
}) {
  const [attempt] = await db
    .select()
    .from(schema.checkoutAttempts)
    .where(eq(schema.checkoutAttempts.stripePaymentIntentId, input.paymentIntent.id))
    .limit(1);
  if (!attempt) return;

  const [funnelSession] = await db
    .select()
    .from(schema.funnelSessions)
    .where(eq(schema.funnelSessions.id, attempt.funnelSessionId))
    .limit(1);
  if (!funnelSession) return;

  const [lead] = await db
    .select({ id: schema.leads.id, anonymousId: schema.leads.anonymousId })
    .from(schema.leads)
    .where(eq(schema.leads.id, funnelSession.leadId))
    .limit(1);
  const distinctId = lead?.anonymousId ?? (lead ? `lead:${lead.id}` : `pi:${input.paymentIntent.id}`);

  await db.transaction(async (tx) => {
    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "checkout_attempt",
        aggregateId: attempt.id,
        dedupeKey: `posthog:Order Cancelled:${input.paymentIntent.id}`,
        event: {
          event: "Order Cancelled",
          eventId: `Order Cancelled:${input.paymentIntent.id}`,
          distinctId,
          anonymousId: lead?.anonymousId ?? undefined,
          timestamp: new Date().toISOString(),
          properties: {
            // No order row exists for failed core payments (orders are created
            // only on payment_intent.succeeded). checkout_id is the canonical
            // identifier here; we deliberately do NOT set order_id so PostHog
            // Revenue Analytics doesn't try to join this to an absent order.
            checkout_id: attempt.id,
            funnel_session_id: attempt.funnelSessionId,
            total: input.paymentIntent.amount / 100,
            currency: input.paymentIntent.currency,
            reason: input.reason,
            stripe_payment_intent_id: input.paymentIntent.id
          }
        }
      })
    ]);
  });
}

