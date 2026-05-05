import { and, eq, sql } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import { JOB_NAMES } from "@agentic-funnel/shared";

import { getBoss } from "../boss";
import type { AppDbTx } from "../db";
import { buildTrackingOutboxEvent, enqueueOutboxEvents } from "./outbox-service";

export async function finalizeOrderAndQueueFulfillment(tx: AppDbTx, input: {
  orderId: string;
  funnelSessionId: string;
  reason: "accepted" | "declined" | "expired" | "charge_failed";
}) {
  const [order] = await tx
    .select({
      id: schema.orders.id,
      closedAt: schema.orders.closedAt,
      fulfillmentStatus: schema.orders.fulfillmentStatus,
      totalAmount: schema.orders.totalAmount,
      currency: schema.orders.currency,
      customerId: schema.orders.customerId,
      metadata: schema.orders.metadata
    })
    .from(schema.orders)
    .where(eq(schema.orders.id, input.orderId))
    .limit(1);

  const funnelKey =
    order?.metadata && typeof order.metadata === "object"
      ? ((order.metadata as { funnelKey?: unknown }).funnelKey as string | undefined) ?? null
      : null;

  if (!order) {
    throw new Error("Order not found during finalization");
  }

  const wasOpen = !order.closedAt;

  if (wasOpen) {
    await tx
      .update(schema.orders)
      .set({
        status: "completed",
        fulfillmentStatus: "queued",
        closedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(schema.orders.id, input.orderId));

    await tx
      .update(schema.funnelSessions)
      .set({
        status: input.reason === "expired" ? "expired" : "closed",
        closedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(schema.funnelSessions.id, input.funnelSessionId));
  }

  await tx
    .update(schema.postPurchaseOfferInstances)
    .set({
      status: "expired",
      decisionSource: input.reason,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.postPurchaseOfferInstances.orderId, input.orderId),
        eq(schema.postPurchaseOfferInstances.status, "presented")
      )
    );

  // Order_Fully_Completed: fires once the funnel session has run out of
  // decisions to present (offer accepted or last offer declined/expired).
  // Lets us measure end-to-end conversion separate from the per-charge
  // `Order Completed` events (core + OTO + downsell can each fire one).
  if (wasOpen) {
    const [customer] = await tx
      .select({ leadId: schema.customers.leadId })
      .from(schema.customers)
      .where(eq(schema.customers.id, order.customerId))
      .limit(1);
    const [lead] = customer
      ? await tx
          .select({ id: schema.leads.id, anonymousId: schema.leads.anonymousId })
          .from(schema.leads)
          .where(eq(schema.leads.id, customer.leadId))
          .limit(1)
      : [undefined];

    const distinctId = lead?.anonymousId ?? (lead ? `lead:${lead.id}` : `order:${input.orderId}`);
    const acceptedCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.postPurchaseOfferInstances)
      .where(
        and(
          eq(schema.postPurchaseOfferInstances.orderId, input.orderId),
          eq(schema.postPurchaseOfferInstances.status, "accepted")
        )
      );
    const acceptedOffers = acceptedCount[0]?.count ?? 0;
    const totalUnits = order.totalAmount / 100;
    const nowIso = new Date().toISOString();

    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "order",
        aggregateId: input.orderId,
        dedupeKey: `posthog:Order_Fully_Completed:${input.orderId}`,
        event: {
          event: "Order_Fully_Completed",
          eventId: `Order_Fully_Completed:${input.orderId}`,
          distinctId,
          anonymousId: lead?.anonymousId ?? undefined,
          timestamp: nowIso,
          properties: {
            order_id: input.orderId,
            funnel_session_id: input.funnelSessionId,
            funnel_key: funnelKey,
            close_reason: input.reason,
            offers_accepted: acceptedOffers,
            grand_total: totalUnits,
            currency: order.currency
          }
        }
      })
    ]);
  }

  const boss = await getBoss();
  await boss.send(
    JOB_NAMES.SEND_FULFILLMENT_EMAIL,
    { orderId: input.orderId },
    {
      singletonKey: `fulfillment:${input.orderId}`
    }
  );
}
