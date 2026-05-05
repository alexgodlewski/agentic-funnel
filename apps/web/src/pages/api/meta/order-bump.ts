import { eq } from "drizzle-orm";
import type { APIRoute } from "astro";
import { z } from "zod";

import { schema } from "@agentic-funnel/db";

import { db } from "../../../lib/server/db";
import { webEnv } from "../../../lib/server/env";
import { buildMetaOutboxEvent, enqueueOutboxEvents } from "../../../lib/server/services/outbox-service";
import { jsonResponse, parseJsonBody } from "../../../lib/server/utils/http";

const orderBumpBeaconSchema = z.object({
  eventId: z.string().trim().min(1),
  leadId: z.string().uuid(),
  funnelSessionId: z.string().uuid(),
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3)
});

export const POST: APIRoute = async ({ request }) => {
  const input = await parseJsonBody(request, orderBumpBeaconSchema);

  try {
    const [lead] = await db
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.id, input.leadId))
      .limit(1);

    if (!lead) {
      return jsonResponse({ ok: true, note: "lead not found, skipped" }, { status: 202 });
    }

    const meta = await buildMetaOutboxEvent({
      aggregateType: "funnel_session",
      aggregateId: input.funnelSessionId,
      eventScope: "addtocart",
      eventKey: `${input.funnelSessionId}:${input.sku}`,
      eventId: input.eventId,
      eventName: "AddToCart",
      eventSourceUrl: `${webEnv.PUBLIC_APP_URL}/checkout`,
      lead: {
        email: lead.email,
        phone: lead.phone,
        firstName: lead.firstName,
        lastName: lead.lastName
      },
      externalId: lead.id,
      request,
      customData: {
        currency: input.currency.toLowerCase(),
        value: input.amount / 100,
        content_type: "product",
        content_ids: [input.sku],
        content_name: input.name,
        contents: [{ id: input.sku, quantity: 1, item_price: input.amount / 100 }],
        num_items: 1,
        funnel_session_id: input.funnelSessionId
      }
    });

    await db.transaction(async (tx) => {
      await enqueueOutboxEvents(tx, [meta.outbox]);
    });
  } catch (error) {
    console.warn("[meta/order-bump] outbox enqueue failed (event still tracked client-side):", error instanceof Error ? error.message : error);
  }

  return jsonResponse({ ok: true }, { status: 202 });
};
