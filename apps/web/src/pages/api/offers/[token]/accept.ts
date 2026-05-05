import type { APIRoute } from "astro";

import { acceptOffer } from "../../../../lib/server/services/offer-service";
import { jsonResponse } from "../../../../lib/server/utils/http";

export const POST: APIRoute = async ({ params, request }) => {
  if (!params.token) {
    return jsonResponse({ error: "Missing offer token" }, { status: 400 });
  }

  try {
    const result = await acceptOffer(params.token, request);
    return jsonResponse(result, { status: 200 });
  } catch (error) {
    console.error("[api/offers/accept] failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
};
