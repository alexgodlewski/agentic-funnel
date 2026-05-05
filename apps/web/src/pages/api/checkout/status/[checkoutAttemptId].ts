import type { APIRoute } from "astro";

import { getCheckoutStatus } from "../../../../lib/server/services/checkout-status-service";
import { jsonResponse } from "../../../../lib/server/utils/http";

export const GET: APIRoute = async ({ params }) => {
  if (!params.checkoutAttemptId) {
    return jsonResponse({ error: "Missing checkout attempt id" }, { status: 400 });
  }

  try {
    const result = await getCheckoutStatus(params.checkoutAttemptId);
    return jsonResponse(result, { status: 200 });
  } catch (error) {
    console.error("[api/checkout/status] failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
