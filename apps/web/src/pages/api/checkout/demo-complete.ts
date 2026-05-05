import type { APIRoute } from "astro";

import { completeDemoCheckout } from "../../../lib/server/services/checkout-status-service";
import { jsonResponse } from "../../../lib/server/utils/http";

export const POST: APIRoute = async ({ request }) => {
  const input = await request.json();
  const result = await completeDemoCheckout(input);

  return jsonResponse(result, { status: 200 });
};
