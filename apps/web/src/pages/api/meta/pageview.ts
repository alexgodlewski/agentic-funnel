import type { APIRoute } from "astro";
import { z } from "zod";

import { db } from "../../../lib/server/db";
import { webEnv } from "../../../lib/server/env";
import { buildMetaOutboxEvent, enqueueOutboxEvents } from "../../../lib/server/services/outbox-service";
import { jsonResponse, parseJsonBody } from "../../../lib/server/utils/http";

const pageviewBeaconSchema = z.object({
  eventId: z.string().trim().min(1),
  path: z.string().trim().min(1),
  distinctId: z.string().trim().min(1).nullable().optional(),
  anonymousId: z.string().trim().min(1).nullable().optional(),
  fbp: z.string().optional(),
  fbc: z.string().optional()
});

export const POST: APIRoute = async ({ request }) => {
  const input = await parseJsonBody(request, pageviewBeaconSchema);

  try {
    const meta = await buildMetaOutboxEvent({
      aggregateType: "pageview",
      aggregateId: input.eventId,
      eventScope: "pageview",
      eventKey: input.eventId,
      eventId: input.eventId,
      eventName: "PageView",
      eventSourceUrl: `${webEnv.PUBLIC_APP_URL}${input.path}`,
      request,
      fbp: input.fbp,
      fbc: input.fbc,
      customData: {
        path: input.path,
        distinct_id: input.distinctId ?? undefined,
        anonymous_id: input.anonymousId ?? undefined
      }
    });

    await db.transaction(async (tx) => {
      await enqueueOutboxEvents(tx, [meta.outbox]);
    });
  } catch (error) {
    console.warn("[meta/pageview] outbox enqueue failed (event still tracked client-side):", error instanceof Error ? error.message : error);
  }

  return jsonResponse({ ok: true }, { status: 202 });
};
