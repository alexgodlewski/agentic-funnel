import { and, asc, eq, lte, or } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";

import { db } from "../lib/db";
import {
  mlAssignGroup,
  mlUnassignGroup,
  mlUpsertCart,
  mlUpsertOrder,
  mlUpsertSubscriber,
  type MlCartItem,
  type MlOrderItem
} from "../lib/mailerlite";
import { dispatchHyrosLead, dispatchHyrosOrder } from "../lib/hyros";
import { sendMailgunMessage } from "../lib/mailgun";
import { dispatchMetaEvent } from "../lib/meta";
import { dispatchPosthogEvent } from "../lib/posthog";

async function markDelivered(id: string) {
  await db
    .update(schema.outboxEvents)
    .set({
      status: "delivered",
      processedAt: new Date(),
      lockedAt: null,
      updatedAt: new Date()
    })
    .where(eq(schema.outboxEvents.id, id));
}

async function markFailed(id: string, attempts: number, error: string) {
  await db
    .update(schema.outboxEvents)
    .set({
      status: attempts >= 5 ? "dead_letter" : "failed",
      lastError: error,
      availableAt: new Date(Date.now() + Math.min(60_000, attempts * 10_000)),
      lockedAt: null,
      updatedAt: new Date()
    })
    .where(eq(schema.outboxEvents.id, id));
}

async function dispatchMailerliteEvent(eventName: string, payload: Record<string, unknown>) {
  switch (eventName) {
    case "subscriber.upsert": {
      await mlUpsertSubscriber({
        email: String(payload.email),
        firstName: payload.firstName as string | null | undefined,
        fields: (payload.fields as Record<string, string | number | null | undefined> | undefined) ?? {},
        groupKeys: (payload.groupKeys as string[] | undefined) ?? []
      });
      return;
    }
    case "cart.upsert": {
      await mlUpsertCart({
        id: String(payload.id),
        email: String(payload.email),
        items: (payload.items as MlCartItem[] | undefined) ?? [],
        total: Number(payload.total ?? 0),
        currency: String(payload.currency ?? "USD")
      });
      return;
    }
    case "order.upsert": {
      await mlUpsertOrder({
        id: String(payload.id),
        email: String(payload.email),
        items: (payload.items as MlOrderItem[] | undefined) ?? [],
        total: Number(payload.total ?? 0),
        currency: String(payload.currency ?? "USD"),
        status: (payload.status as "complete" | "cancelled" | undefined) ?? "complete"
      });
      return;
    }
    case "subscriber.group.assign": {
      await mlAssignGroup(String(payload.email), String(payload.groupKey));
      return;
    }
    case "subscriber.group.unassign": {
      await mlUnassignGroup(String(payload.email), String(payload.groupKey));
      return;
    }
    default:
      throw new Error(`Unknown mailerlite eventName: ${eventName}`);
  }
}

async function afterMailSuccess(event: typeof schema.outboxEvents.$inferSelect) {
  if (event.eventName !== "mail.send") {
    return;
  }

  if (event.aggregateType === "order") {
    await db
      .update(schema.orders)
      .set({
        fulfillmentStatus: "sent",
        updatedAt: new Date()
      })
      .where(eq(schema.orders.id, event.aggregateId));

    // Load lead.anonymousId so the Fulfillment Sent event lands on the same
    // PostHog person as Lead Submitted / Order Completed (single distinct_id
    // chain across the whole funnel).
    const [order] = await db
      .select({
        customerId: schema.orders.customerId,
        funnelSessionId: schema.orders.funnelSessionId,
        metadata: schema.orders.metadata
      })
      .from(schema.orders)
      .where(eq(schema.orders.id, event.aggregateId))
      .limit(1);
    const [customer] = order
      ? await db
          .select({ leadId: schema.customers.leadId })
          .from(schema.customers)
          .where(eq(schema.customers.id, order.customerId))
          .limit(1)
      : [undefined];
    const [lead] = customer
      ? await db
          .select({ id: schema.leads.id, anonymousId: schema.leads.anonymousId })
          .from(schema.leads)
          .where(eq(schema.leads.id, customer.leadId))
          .limit(1)
      : [undefined];
    const distinctId =
      lead?.anonymousId ?? (lead ? `lead:${lead.id}` : `order:${event.aggregateId}`);
    const funnelKey =
      order?.metadata && typeof order.metadata === "object"
        ? ((order.metadata as { funnelKey?: unknown }).funnelKey as string | undefined) ?? null
        : null;

    await db
      .insert(schema.outboxEvents)
      .values({
        aggregateType: "order",
        aggregateId: event.aggregateId,
        channel: "posthog",
        eventName: "Fulfillment Sent",
        dedupeKey: `posthog:Fulfillment Sent:${event.aggregateId}`,
        payload: {
          event: "Fulfillment Sent",
          eventId: `Fulfillment Sent:${event.aggregateId}`,
          distinctId,
          ...(lead?.anonymousId ? { anonymousId: lead.anonymousId } : {}),
          timestamp: new Date().toISOString(),
          properties: {
            order_id: event.aggregateId,
            funnel_session_id: order?.funnelSessionId ?? null,
            funnel_key: funnelKey
          }
        }
      })
      .onConflictDoNothing({ target: schema.outboxEvents.dedupeKey });
  }
}

export async function processPendingOutbox(limit = 25) {
  const candidates = await db
    .select()
    .from(schema.outboxEvents)
    .where(
      and(
        or(eq(schema.outboxEvents.status, "pending"), eq(schema.outboxEvents.status, "failed")),
        lte(schema.outboxEvents.availableAt, new Date())
      )
    )
    .orderBy(asc(schema.outboxEvents.createdAt))
    .limit(limit);

  for (const event of candidates) {
    try {
      await db
        .update(schema.outboxEvents)
        .set({
          status: "processing",
          attempts: event.attempts + 1,
          lockedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(schema.outboxEvents.id, event.id));

      switch (event.channel) {
        case "posthog":
          await dispatchPosthogEvent(event.payload);
          break;
        case "meta":
          await dispatchMetaEvent(event.payload);
          break;
        case "mailgun":
          if (event.eventName === "mail.send") {
            await sendMailgunMessage(event.payload);
            await afterMailSuccess(event);
          }
          break;
        case "mailerlite":
          await dispatchMailerliteEvent(event.eventName, event.payload);
          break;
        case "hyros":
          if (event.eventName === "order.send") {
            await dispatchHyrosOrder(event.payload);
          } else if (event.eventName === "lead.send") {
            await dispatchHyrosLead(event.payload);
          }
          break;
        case "internal":
          break;
      }

      await markDelivered(event.id);
    } catch (error) {
      await markFailed(event.id, event.attempts + 1, error instanceof Error ? error.message : String(error));
    }
  }
}
