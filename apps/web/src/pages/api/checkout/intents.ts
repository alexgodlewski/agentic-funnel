import type { APIRoute } from "astro";

import { createOrUpdateCheckoutIntent } from "../../../lib/server/services/checkout-service";
import { jsonResponse } from "../../../lib/server/utils/http";

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await request.json();
    const result = await createOrUpdateCheckoutIntent(input, request);
    return jsonResponse(result, { status: 200 });
  } catch (error) {
    console.error("[api/checkout/intents] failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
