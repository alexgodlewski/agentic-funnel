import { eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import { metaEventId } from "@agentic-funnel/shared";

import { db } from "../db";
import { webEnv } from "../env";
import { buildMetaOutboxEvent, enqueueOutboxEvents } from "./outbox-service";

export type PurchaseSettlement = {
  eventId: string;
  value: number;
  currency: string;
  contents: Array<{ id: string; quantity: number; item_price: number }>;
  numItems: number;
};

export async function getPurchaseSnapshot(orderId: string): Promise<PurchaseSettlement | null> {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    return null;
  }

  const lines = await db
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, orderId));

  if (lines.length === 0) {
    return null;
  }

  const contents = lines.map((line) => ({
    id: line.sku,
    quantity: line.quantity,
    item_price: line.unitAmount / 100
  }));

  return {
    eventId: metaEventId("purchase", orderId),
    value: order.totalAmount / 100,
    currency: order.currency,
    contents,
    numItems: contents.reduce((sum, c) => sum + c.quantity, 0)
  };
}

// Enqueues a Meta CAPI Purchase outbox event with a deterministic eventId
// (`purchase:<orderId>`) that matches the browser pixel fired from the
// thank-you page. The outbox dedupeKey is unique on the eventId, so calling
// this multiple times across the funnel (thank-you visit, OTO accept finalize,
// async webhook, etc.) only enqueues the first one — Meta sees the snapshot
// taken at the first call site. Returns the snapshot in either case so the
// caller can also fire the browser pixel.
//
// We deliberately do NOT gate on `order.closedAt`. The order row only exists
// after a successful core payment, so firing Purchase here is always correct.
// Without this, non-OTO funnels (or async-payment redirects that race the
// webhook) would never enqueue a CAPI Purchase, leaving Meta with browser-only
// signal and an asymmetric dedup pair.
export async function firePurchaseIfTerminal(
  orderId: string,
  request?: Request
): Promise<PurchaseSettlement | null> {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);

  if (!order) {
    return null;
  }

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, order.customerId))
    .limit(1);

  if (!customer) {
    return null;
  }

  const [lead] = await db
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.id, customer.leadId))
    .limit(1);

  if (!lead) {
    return null;
  }

  const snapshot = await getPurchaseSnapshot(orderId);
  if (!snapshot) {
    return null;
  }

  const meta = await buildMetaOutboxEvent({
    aggregateType: "order",
    aggregateId: order.id,
    eventScope: "purchase",
    eventKey: order.id,
    eventName: "Purchase",
    eventSourceUrl: `${webEnv.PUBLIC_APP_URL}/thank-you/${order.id}`,
    lead: {
      email: lead.email,
      phone: lead.phone,
      firstName: lead.firstName,
      lastName: lead.lastName
    },
    externalId: lead.id,
    request,
    customData: {
      currency: snapshot.currency,
      value: snapshot.value,
      content_type: "product",
      content_ids: snapshot.contents.map((c) => c.id),
      contents: snapshot.contents,
      num_items: snapshot.numItems,
      order_id: order.id,
      funnel_session_id: order.funnelSessionId
    }
  });

  await db.transaction(async (tx) => {
    await enqueueOutboxEvents(tx, [meta.outbox]);
  });

  return snapshot;
}
