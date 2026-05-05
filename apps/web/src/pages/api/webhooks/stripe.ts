import type { APIRoute } from "astro";

import { stripe } from "../../../lib/server/integrations/stripe";
import { webEnv } from "../../../lib/server/env";
import { handleStripeEvent } from "../../../lib/server/services/webhook-service";
import { jsonResponse } from "../../../lib/server/utils/http";

export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return jsonResponse({ error: "Missing Stripe signature" }, { status: 400 });
  }

  const body = await request.text();
  const event = stripe.webhooks.constructEvent(body, signature, webEnv.STRIPE_WEBHOOK_SECRET);
  await handleStripeEvent(event);

  return jsonResponse({ received: true }, { status: 200 });
};
