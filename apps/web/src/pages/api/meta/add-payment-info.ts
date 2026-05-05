import { eq } from "drizzle-orm";
import type { APIRoute } from "astro";
import { z } from "zod";

import { schema } from "@agentic-funnel/db";

import { db } from "../../../lib/server/db";
import { webEnv } from "../../../lib/server/env";
import { buildMetaOutboxEvent, enqueueOutboxEvents } from "../../../lib/server/services/outbox-service";
import { jsonResponse, parseJsonBody } from "../../../lib/server/utils/http";

const addPaymentInfoBeaconSchema = z.object({
  eventId: z.string().trim().min(1),
  leadId: z.string().uuid(),
  funnelSessionId: z.string().uuid(),
  checkoutAttemptId: z.string().uuid().optional(),
  amount: z.number().int().nonnegative(),
  currency: z.string().length(3),
  contentIds: z.array(z.string().min(1)).default([]),
  fbp: z.string().optional(),
  fbc: z.string().optional()
});

export const POST: APIRoute = async ({ request }) => {
  const input = await parseJsonBody(request, addPaymentInfoBeaconSchema);

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
      aggregateType: "checkout_attempt",
      aggregateId: input.checkoutAttemptId ?? input.funnelSessionId,
      eventScope: "add_payment_info",
      eventKey: input.checkoutAttemptId ?? input.funnelSessionId,
      eventId: input.eventId,
      eventName: "AddPaymentInfo",
      eventSourceUrl: `${webEnv.PUBLIC_APP_URL}/checkout`,
      lead: {
        email: lead.email,
        phone: lead.phone,
        firstName: lead.firstName,
        lastName: lead.lastName
      },
      externalId: lead.id,
      request,
      fbp: input.fbp,
      fbc: input.fbc,
      customData: {
        currency: input.currency.toLowerCase(),
        value: input.amount / 100,
        content_type: "product",
        content_ids: input.contentIds,
        funnel_session_id: input.funnelSessionId,
        ...(input.checkoutAttemptId ? { checkout_attempt_id: input.checkoutAttemptId } : {})
      }
    });

    await db.transaction(async (tx) => {
      await enqueueOutboxEvents(tx, [meta.outbox]);
    });
  } catch (error) {
    console.warn(
      "[meta/add-payment-info] outbox enqueue failed (event still tracked client-side):",
      error instanceof Error ? error.message : error
    );
  }

  return jsonResponse({ ok: true }, { status: 202 });
};
