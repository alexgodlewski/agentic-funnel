import { eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import { JOB_NAMES, checkoutQuoteSchema } from "@agentic-funnel/shared";

import { getFunnelDefinition } from "../../config/funnels";
import { getBoss } from "../boss";
import { db } from "../db";
import { webEnv } from "../env";
import { createInitialOfferInstance } from "./offer-service";
import {
  buildHyrosOrderOutboxEvent,
  buildMailerliteOutboxEvent,
  buildTrackingOutboxEvent,
  enqueueOutboxEvents
} from "./outbox-service";

type FinalizeCorePaymentInput = {
  paymentIntentId: string;
  amount: number;
  currency: string;
  paymentMethodId?: string | null;
  chargeId?: string | null;
};

export async function finalizeSuccessfulCorePayment(input: FinalizeCorePaymentInput) {
  const [checkoutAttempt] = await db
    .select()
    .from(schema.checkoutAttempts)
    .where(eq(schema.checkoutAttempts.stripePaymentIntentId, input.paymentIntentId))
    .limit(1);

  if (!checkoutAttempt) {
    return null;
  }

  const [funnelSession] = await db
    .select()
    .from(schema.funnelSessions)
    .where(eq(schema.funnelSessions.id, checkoutAttempt.funnelSessionId))
    .limit(1);

  if (!funnelSession) {
    throw new Error("Funnel session missing for successful payment");
  }

  const [lead] = await db
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.id, funnelSession.leadId))
    .limit(1);

  if (!lead) {
    throw new Error("Lead missing for successful payment");
  }

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.leadId, lead.id))
    .limit(1);

  if (!customer) {
    throw new Error("Customer missing for successful payment");
  }

  const [existingOrder] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.stripePrimaryPaymentIntentId, input.paymentIntentId))
    .limit(1);

  if (existingOrder) {
    return {
      orderId: existingOrder.id,
      funnelSessionId: existingOrder.funnelSessionId
    };
  }

  const quote = checkoutQuoteSchema.parse(checkoutAttempt.quoteSnapshot);
  const postPurchaseWindowMinutes = webEnv.POST_PURCHASE_WINDOW_MINUTES;
  const expiresAt = new Date(Date.now() + postPurchaseWindowMinutes * 60_000);

  const order = await db.transaction(async (tx) => {
    await tx
      .update(schema.checkoutAttempts)
      .set({
        status: "succeeded",
        updatedAt: new Date()
      })
      .where(eq(schema.checkoutAttempts.id, checkoutAttempt.id));

    await tx
      .update(schema.funnelSessions)
      .set({
        status: "core_purchased",
        expiresAt,
        updatedAt: new Date()
      })
      .where(eq(schema.funnelSessions.id, funnelSession.id));

    const [createdOrder] = await tx
      .insert(schema.orders)
      .values({
        funnelSessionId: funnelSession.id,
        customerId: customer.id,
        stripePrimaryPaymentIntentId: input.paymentIntentId,
        currency: quote.currency,
        totalAmount: quote.totalAmount,
        coreAmount: quote.items.find((item) => item.kind === "core")?.totalAmount ?? quote.totalAmount,
        orderBumpAmount: quote.items.find((item) => item.kind === "order_bump")?.totalAmount ?? 0,
        status: "awaiting_post_purchase",
        fulfillmentStatus: "pending",
        expiresAt,
        metadata: {
          funnelKey: quote.funnelKey,
          quote,
          offerSnapshot: quote.offerSnapshot
        }
      })
      .returning();

    await tx.insert(schema.orderLines).values(
      quote.items.map((item) => ({
        orderId: createdOrder.id,
        kind: item.kind,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitAmount: item.unitAmount,
        totalAmount: item.totalAmount,
        // assetBundleId is legacy. Downloads now flow via metadata.r2Key
        // (set by buildCheckoutQuote from Stripe Product metadata.r2_key).
        assetBundleId: null,
        metadata: item.metadata
      }))
    );

    await tx.insert(schema.paymentRecords).values({
      orderId: createdOrder.id,
      stripePaymentIntentId: input.paymentIntentId,
      stripeChargeId: input.chargeId ?? null,
      stripePaymentMethodId: input.paymentMethodId ?? null,
      type: "core",
      amount: input.amount,
      currency: input.currency,
      status: "succeeded",
      metadata: {}
    });

    return createdOrder;
  });

  // STRIPE_PRICE_OTO unset → createInitialOfferInstance returns null → no
  // `presented` offer row → checkout-status routes straight to /thank-you.
  await createInitialOfferInstance({
    orderId: order.id,
    funnelSessionId: funnelSession.id,
    funnelKey: quote.funnelKey,
    expiresAt
  });

  await db.transaction(async (tx) => {
    // Bump skip evaluation: which configured bump SKUs were NOT in the order.
    // Skipped bumps → assign leads-not-bought-bump-N for reactivation flow.
    // Purchased bumps → defensive unassign in case the buyer re-purchased.
    const funnel = getFunnelDefinition(quote.funnelKey);
    const purchasedSkus = new Set(quote.items.map((item) => item.sku));
    const slotToGroupKey: Record<string, string> = {
      ORDER_BUMP_1: "leads_not_bought_bump_1",
      ORDER_BUMP_2: "leads_not_bought_bump_2"
    };
    const bumpGroupEvents = funnel.orderBumps.flatMap((bump) => {
      const groupKey = slotToGroupKey[bump.slot];
      if (!groupKey) return [];
      const skipped = !purchasedSkus.has(bump.sku);
      return [
        buildMailerliteOutboxEvent({
          aggregateType: "order",
          aggregateId: order.id,
          dedupeKey: `mailerlite:bump-${skipped ? "skip" : "unskip"}:${order.id}:${bump.slot}`,
          eventName: skipped ? "subscriber.group.assign" : "subscriber.group.unassign",
          payload: { email: lead.email, groupKey }
        })
      ];
    });

    const distinctId = lead.anonymousId ?? `lead:${lead.id}`;
    // Dedupe on the Stripe PaymentIntent so retried webhook deliveries don't
    // create duplicate Order Completed events in PostHog (Revenue Analytics
    // would otherwise double-count). $insert_id is sourced from `eventId`.
    const orderCompletedEventId = `Order Completed:pi:${input.paymentIntentId}`;
    const productsPayload = quote.items.map((item) => ({
      product_id: item.sku,
      sku: item.sku,
      name: item.name,
      category: item.kind,
      price: item.unitAmount / 100,
      quantity: item.quantity
    }));
    const totalUnits = quote.totalAmount / 100;
    const subtotalUnits = quote.subtotalAmount / 100;
    const discountUnits = (quote.discount?.amount ?? 0) / 100;
    const nowIso = new Date().toISOString();
    const appHost = new URL(webEnv.PUBLIC_APP_URL).hostname;

    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "order",
        aggregateId: order.id,
        dedupeKey: `posthog:Order Completed:${order.id}:core`,
        event: {
          event: "Order Completed",
          eventId: orderCompletedEventId,
          distinctId,
          anonymousId: lead.anonymousId ?? undefined,
          timestamp: nowIso,
          properties: {
            order_id: order.id,
            checkout_id: checkoutAttempt.id,
            affiliation: "stripe",
            total: totalUnits,
            subtotal: subtotalUnits,
            revenue: totalUnits,
            shipping: 0,
            tax: 0,
            discount: discountUnits,
            coupon: quote.discount?.promoCode ?? null,
            currency: quote.currency,
            offer_kind: "core",
            parent_order_id: null,
            funnel_session_id: funnelSession.id,
            funnel_key: quote.funnelKey,
            lead_id: lead.id,
            products: productsPayload,
            stripe_payment_intent_id: input.paymentIntentId,
            host: appHost,
            app_source: "astro_native"
          },
          set: {
            email: lead.email,
            first_name: lead.firstName ?? null,
            last_name: lead.lastName ?? null,
            phone: lead.phone ?? null,
            funnel_key: quote.funnelKey,
            lead_id: lead.id,
            last_purchase_at: nowIso,
            last_seen_at: nowIso
          }
        }
      }),
      buildMailerliteOutboxEvent({
        aggregateType: "order",
        aggregateId: order.id,
        dedupeKey: `mailerlite:order:${order.id}`,
        eventName: "order.upsert",
        payload: {
          id: order.id,
          email: lead.email,
          currency: quote.currency,
          total: quote.totalAmount / 100,
          status: "complete",
          items: quote.items.map((item) => ({
            product_id: item.sku,
            name: item.name,
            price: item.unitAmount / 100,
            quantity: item.quantity
          }))
        }
      }),
      buildMailerliteOutboxEvent({
        aggregateType: "order",
        aggregateId: order.id,
        dedupeKey: `mailerlite:assign-customers:${order.id}`,
        eventName: "subscriber.group.assign",
        payload: { email: lead.email, groupKey: "leads_customers" }
      }),
      buildMailerliteOutboxEvent({
        aggregateType: "order",
        aggregateId: order.id,
        dedupeKey: `mailerlite:unassign-nurture:${order.id}`,
        eventName: "subscriber.group.unassign",
        payload: { email: lead.email, groupKey: "leads_lead_nurture" }
      }),
      // Hyros — completes the click → purchase loop. Dedupe on the Stripe
      // PaymentIntent so retried webhook deliveries don't post duplicate
      // sales. orderId stays consistent across core + OTO + downsell so
      // Hyros groups them as a single transaction.
      buildHyrosOrderOutboxEvent({
        aggregateType: "order",
        aggregateId: order.id,
        dedupeKey: `hyros:order:${order.id}:pi:${input.paymentIntentId}`,
        payload: {
          email: lead.email,
          firstName: lead.firstName ?? undefined,
          lastName: lead.lastName ?? undefined,
          phoneNumbers: lead.phone ? [lead.phone] : undefined,
          orderId: order.id,
          date: nowIso,
          currency: quote.currency.toUpperCase(),
          priceFormat: "DECIMAL",
          items: quote.items.map((item) => ({
            name: item.name,
            price: item.unitAmount / 100,
            quantity: item.quantity,
            externalId: item.sku,
            tag: item.kind
          }))
        }
      }),
      ...bumpGroupEvents
    ]);
  });

  const boss = await getBoss();
  await boss.send(
    JOB_NAMES.EXPIRE_FUNNEL,
    { orderId: order.id, funnelSessionId: funnelSession.id },
    {
      singletonKey: `expire:${order.id}`,
      startAfter: expiresAt
    }
  );

  return {
    orderId: order.id,
    funnelSessionId: funnelSession.id
  };
}
