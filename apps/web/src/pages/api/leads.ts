import type { APIRoute } from "astro";
import { randomUUID } from "node:crypto";

import { captureLead } from "../../lib/server/services/lead-service";
import { parseJsonBody, jsonResponse } from "../../lib/server/utils/http";
import { leadCaptureInputSchema } from "@agentic-funnel/shared";

const isDbConnectionError = (error: unknown): boolean => {
  if (!error) return false;
  const e = error as { code?: string; message?: string; errors?: unknown[]; cause?: unknown };
  if (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND") return true;
  const blob = `${e.message ?? ""} ${JSON.stringify(e.errors ?? [])}`.toLowerCase();
  if (
    blob.includes("econnrefused") ||
    blob.includes("etimedout") ||
    blob.includes("getaddrinfo") ||
    blob.includes("password authentication") ||
    blob.includes('relation "')
  ) {
    return true;
  }
  return e.cause ? isDbConnectionError(e.cause) : false;
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await parseJsonBody(request, leadCaptureInputSchema);
    const result = await captureLead(input, request);
    return jsonResponse(result, { status: 201 });
  } catch (error) {
    // In non-production, if Postgres isn't reachable yet, fall back to a
    // synthetic lead so the funnel UI flow (popup → /checkout pre-fill) can be
    // exercised without spinning up the local infra. Production must always hit
    // the real DB.
    if (process.env.NODE_ENV !== "production" && isDbConnectionError(error)) {
      console.warn("[api/leads] DB unreachable — issuing demo lead session", error);
      return jsonResponse(
        {
          leadId: randomUUID(),
          funnelSessionId: randomUUID(),
          metaEventIds: {},
          mode: "demo"
        },
        { status: 201 }
      );
    }
    console.error("[api/leads] failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
