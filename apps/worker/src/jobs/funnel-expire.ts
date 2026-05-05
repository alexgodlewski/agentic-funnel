import { and, eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";

import { db } from "../lib/db";
import { queueFulfillmentEmail } from "./fulfillment";

function offerKindToNotBoughtGroupKey(kind: "oto" | "downsell"): string {
  return kind === "oto" ? "leads_not_bought_oto" : "leads_not_bought_downsell";
}

function readFunnelKeyFromOrder(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const fk = (metadata as { funnelKey?: unknown }).funnelKey;
  return typeof fk === "string" && fk.length > 0 ? fk : null;
}

export async function expireOpenFunnel(payload: { orderId: string; funnelSessionId: string }) {
  await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, payload.orderId))
      .limit(1);

    if (!order) {
      return;
    }

    // The expire job's pg-boss firing IS the expiry signal. Even if the order
    // was already synchronously closed (e.g., OTO declined → no downsell),
    // we still emit Funnel Expired so it's discoverable in PostHog. The state
    // mutations below skip when already closed (the order has nothing left to
    // change).
    const alreadyClosed = Boolean(order.closedAt);
    const funnelKey = readFunnelKeyFromOrder(order.metadata);

    // Capture the still-presented offers BEFORE we flip them to expired so we
    // can tag the lead into the right leads-not-bought-* group(s). Shared
    // dedupe key with the declineOffer path means a decline-then-expire
    // (or vice versa) collapses to a single group assignment.
    const presentedOffers = alreadyClosed
      ? []
      : await tx
          .select()
          .from(schema.postPurchaseOfferInstances)
          .where(
            and(
              eq(schema.postPurchaseOfferInstances.orderId, payload.orderId),
              eq(schema.postPurchaseOfferInstances.status, "presented")
            )
          );

    const [customer] = await tx
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, order.customerId))
      .limit(1);
    const [lead] = customer
      ? await tx.select().from(schema.leads).where(eq(schema.leads.id, customer.leadId)).limit(1)
      : [undefined];

    if (!alreadyClosed) {
      await tx
        .update(schema.postPurchaseOfferInstances)
        .set({
          status: "expired",
          decisionSource: "timeout",
          failedAt: null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.postPurchaseOfferInstances.orderId, payload.orderId),
            eq(schema.postPurchaseOfferInstances.status, "presented")
          )
        );

      await tx
        .update(schema.orders)
        .set({
          status: "completed",
          fulfillmentStatus: "queued",
          closedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(schema.orders.id, payload.orderId));

      await tx
        .update(schema.funnelSessions)
        .set({
          status: "expired",
          closedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(schema.funnelSessions.id, payload.funnelSessionId));
    }

    const distinctId = lead?.anonymousId ?? (lead ? `lead:${lead.id}` : `order:${payload.orderId}`);
    const nowIso = new Date().toISOString();

    await tx
      .insert(schema.outboxEvents)
      .values([
        {
          aggregateType: "order",
          aggregateId: payload.orderId,
          channel: "posthog",
          eventName: "Funnel Expired",
          dedupeKey: `posthog:Funnel Expired:${payload.orderId}`,
          payload: {
            event: "Funnel Expired",
            eventId: `Funnel Expired:${payload.orderId}`,
            distinctId,
            ...(lead?.anonymousId ? { anonymousId: lead.anonymousId } : {}),
            timestamp: nowIso,
            properties: {
              order_id: payload.orderId,
              funnel_session_id: payload.funnelSessionId,
              funnel_key: funnelKey,
              already_closed: alreadyClosed
            }
          }
        },
        {
          aggregateType: "order",
          aggregateId: payload.orderId,
          channel: "posthog",
          eventName: "Order_Fully_Completed",
          // Same dedupeKey as the sync-close path in order-service.ts —
          // onConflictDoNothing collapses both into one event in PostHog.
          dedupeKey: `posthog:Order_Fully_Completed:${payload.orderId}`,
          payload: {
            event: "Order_Fully_Completed",
            eventId: `Order_Fully_Completed:${payload.orderId}`,
            distinctId,
            ...(lead?.anonymousId ? { anonymousId: lead.anonymousId } : {}),
            timestamp: nowIso,
            properties: {
              order_id: payload.orderId,
              funnel_session_id: payload.funnelSessionId,
              funnel_key: funnelKey,
              close_reason: "expired",
              grand_total: order.totalAmount / 100,
              currency: order.currency
            }
          }
        }
      ])
      .onConflictDoNothing({ target: schema.outboxEvents.dedupeKey });

    if (lead && presentedOffers.length > 0) {
      const skipEvents = presentedOffers
        .filter((offer) => offer.type === "oto" || offer.type === "downsell")
        .map((offer) => ({
          aggregateType: "offer",
          aggregateId: offer.id,
          channel: "mailerlite" as const,
          eventName: "subscriber.group.assign",
          dedupeKey: `mailerlite:offer-skip:${offer.id}`,
          payload: {
            email: lead.email,
            groupKey: offerKindToNotBoughtGroupKey(offer.type as "oto" | "downsell")
          },
          availableAt: new Date()
        }));

      if (skipEvents.length > 0) {
        await tx
          .insert(schema.outboxEvents)
          .values(skipEvents)
          .onConflictDoNothing({ target: schema.outboxEvents.dedupeKey });
      }
    }
  });

  await queueFulfillmentEmail({ orderId: payload.orderId });
}
