import { and, desc, eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import {
  checkoutStatusResponseSchema,
  demoCheckoutConfirmInputSchema
} from "@agentic-funnel/shared";

import { db } from "../db";
import { createDemoProviderId, isStripeConfigured } from "../utils/providers";
import { finalizeSuccessfulCorePayment } from "./core-payment-service";
import { issueOfferTokenForOfferInstance } from "./offer-service";

export async function getCheckoutStatus(checkoutAttemptId: string) {
  const [checkoutAttempt] = await db
    .select()
    .from(schema.checkoutAttempts)
    .where(eq(schema.checkoutAttempts.id, checkoutAttemptId))
    .limit(1);

  if (!checkoutAttempt) {
    throw new Error("Checkout attempt not found");
  }

  // Prefer matching by the attempt's CURRENT PaymentIntent — a single
  // funnel_session can produce multiple orders if the buyer refreshes
  // /checkout after a successful payment (each retry uses a fresh PI; see
  // #11). Falling back to funnel_session_id with `.limit(1)` and no
  // orderBy let Postgres pick the wrong (often oldest, pre-OTO-flag) row.
  const [order] = checkoutAttempt.stripePaymentIntentId
    ? await db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.stripePrimaryPaymentIntentId, checkoutAttempt.stripePaymentIntentId))
        .limit(1)
    : await db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.funnelSessionId, checkoutAttempt.funnelSessionId))
        .orderBy(desc(schema.orders.createdAt))
        .limit(1);

  if (!order) {
    return checkoutStatusResponseSchema.parse({
      checkoutAttemptId: checkoutAttempt.id,
      status: checkoutAttempt.status,
      paymentIntentId: checkoutAttempt.stripePaymentIntentId ?? undefined
    });
  }

  const [presentedOffer] = await db
    .select()
    .from(schema.postPurchaseOfferInstances)
    .where(
      and(
        eq(schema.postPurchaseOfferInstances.orderId, order.id),
        eq(schema.postPurchaseOfferInstances.status, "presented")
      )
    )
    .orderBy(desc(schema.postPurchaseOfferInstances.createdAt))
    .limit(1);

  if (presentedOffer) {
    const nextToken = await issueOfferTokenForOfferInstance(presentedOffer.id);
    const offerPath = presentedOffer.type === "oto" ? "oto" : "downsell";

    return checkoutStatusResponseSchema.parse({
      checkoutAttemptId: checkoutAttempt.id,
      status: "succeeded",
      paymentIntentId: checkoutAttempt.stripePaymentIntentId ?? undefined,
      orderId: order.id,
      nextStep: "oto",
      nextUrl: `/${offerPath}/${nextToken}`
    });
  }

  return checkoutStatusResponseSchema.parse({
    checkoutAttemptId: checkoutAttempt.id,
    status: "succeeded",
    paymentIntentId: checkoutAttempt.stripePaymentIntentId ?? undefined,
    orderId: order.id,
    nextStep: "thank_you",
    nextUrl: `/thank-you/${order.id}`
  });
}

export async function completeDemoCheckout(input: unknown) {
  if (isStripeConfigured()) {
    throw new Error("Demo checkout is only available when Stripe credentials are not configured");
  }

  const parsed = demoCheckoutConfirmInputSchema.parse(input);
  const [checkoutAttempt] = await db
    .select()
    .from(schema.checkoutAttempts)
    .where(eq(schema.checkoutAttempts.id, parsed.checkoutAttemptId))
    .limit(1);

  if (!checkoutAttempt) {
    throw new Error("Checkout attempt not found");
  }

  await finalizeSuccessfulCorePayment({
    paymentIntentId: checkoutAttempt.stripePaymentIntentId ?? createDemoProviderId("pi"),
    amount: checkoutAttempt.amount,
    currency: checkoutAttempt.currency,
    paymentMethodId: createDemoProviderId("pm"),
    chargeId: createDemoProviderId("ch")
  });

  return getCheckoutStatus(parsed.checkoutAttemptId);
}
