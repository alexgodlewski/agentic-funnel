import { hyrosLeadPayloadSchema, hyrosOrderPayloadSchema } from "@agentic-funnel/shared";

import { workerEnv } from "./env";

const HYROS_ORDERS_URL = "https://api.hyros.com/api/v1.0/orders";
const HYROS_LEADS_URL = "https://api.hyros.com/api/v1.0/leads";

type HyrosResponse = {
  request_id?: string;
  result?: "OK" | "ERROR";
  message?: string[] | string;
};

async function postToHyros(url: string, body: unknown, label: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "API-Key": workerEnv.HYROS_API_KEY!,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Hyros ${label} dispatch failed with ${response.status}: ${text}`);
  }

  // Hyros returns 200 even on validation errors — the response body indicates
  // result=ERROR with a message array. Treat those as failures so the outbox
  // marks them for retry / dead-letter rather than silently dropping.
  const json = (await response.json().catch(() => null)) as HyrosResponse | null;
  if (json?.result === "ERROR") {
    const msg = Array.isArray(json.message) ? json.message.join("; ") : (json.message ?? "");
    throw new Error(`Hyros ${label} rejected: ${msg}`);
  }
}

/**
 * POST an order to Hyros so they can complete the click → purchase loop.
 * Hyros matches the buyer back to a tracked click via `email` (or
 * `phoneNumbers`), then attributes the sale to whichever ad/click drove the
 * landing visit.
 */
export async function dispatchHyrosOrder(payload: Record<string, unknown>) {
  if (!workerEnv.HYROS_API_KEY) {
    console.log("[hyros] HYROS_API_KEY not set — skipping order dispatch");
    return;
  }

  const parsed = hyrosOrderPayloadSchema.parse(payload);
  await postToHyros(HYROS_ORDERS_URL, parsed, "order");
}

/**
 * POST a lead to Hyros so it can stitch the buyer to the click that brought
 * them in before purchase — improves attribution coverage for funnels where
 * leads convert later or via a different device.
 */
export async function dispatchHyrosLead(payload: Record<string, unknown>) {
  if (!workerEnv.HYROS_API_KEY) {
    console.log("[hyros] HYROS_API_KEY not set — skipping lead dispatch");
    return;
  }

  const parsed = hyrosLeadPayloadSchema.parse(payload);
  await postToHyros(HYROS_LEADS_URL, parsed, "lead");
}
