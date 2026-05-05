import { and, desc, eq } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import {
  checkoutIntentInputSchema,
  checkoutIntentResponseSchema
} from "@agentic-funnel/shared";

import { buildCheckoutQuote, type ResolvedDiscount } from "../../config/funnels";
import { db } from "../db";
import { stripe } from "../integrations/stripe";
import { webEnv } from "../env";
import {
  createDemoProviderId,
  isDemoProviderId,
  isStripeConfigured
} from "../utils/providers";
import {
  buildMailerliteOutboxEvent,
  buildMetaOutboxEvent,
  buildTrackingOutboxEvent,
  enqueueOutboxEvents
} from "./outbox-service";

async function ensureCustomer(leadId: string, email: string, firstName?: string | null, lastName?: string | null) {
  const [existingCustomer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.leadId, leadId))
    .limit(1);

  // posthog_distinct_id mirrors the lead's anonymousId so any future code that
  // reads it gets the canonical PostHog person identifier (not the legacy
  // `customer:<id>` alias). We resolve this via a fresh lookup since the lead
  // row may have been updated since the customer was first created.
  const [leadForDistinctId] = await db
    .select({ anonymousId: schema.leads.anonymousId })
    .from(schema.leads)
    .where(eq(schema.leads.id, leadId))
    .limit(1);
  const posthogDistinctId = leadForDistinctId?.anonymousId ?? `lead:${leadId}`;

  const stripeReady = isStripeConfigured();
  if (
    existingCustomer?.stripeCustomerId &&
    (!stripeReady || !isDemoProviderId(existingCustomer.stripeCustomerId))
  ) {
    // Verify the stored cus_* still exists in the active Stripe mode. A test→live
    // env flip leaves stale test-mode customer IDs in the DB; using them downstream
    // surfaces as "No such customer" 500s on PaymentIntent create. If retrieve
    // fails with resource_missing (or any retrieve error), fall through and
    // create a fresh customer below.
    if (!stripeReady) return existingCustomer;
    try {
      const fetched = await stripe.customers.retrieve(existingCustomer.stripeCustomerId);
      if (!("deleted" in fetched) || !fetched.deleted) {
        return existingCustomer;
      }
    } catch {
      /* fall through, recreate */
    }
  }

  if (!stripeReady) {
    const demoStripeCustomerId = existingCustomer?.stripeCustomerId ?? createDemoProviderId("cus");

    if (existingCustomer) {
      const [updatedCustomer] = await db
        .update(schema.customers)
        .set({
          stripeCustomerId: demoStripeCustomerId,
          posthogDistinctId,
          updatedAt: new Date()
        })
        .where(eq(schema.customers.id, existingCustomer.id))
        .returning();

      return updatedCustomer;
    }

    const [customer] = await db
      .insert(schema.customers)
      .values({
        leadId,
        stripeCustomerId: demoStripeCustomerId,
        posthogDistinctId,
        metadata: {
          mode: "demo"
        }
      })
      .returning();

    return customer;
  }

  const stripeCustomer = await stripe.customers.create({
    email,
    name: [firstName, lastName].filter(Boolean).join(" ") || undefined,
    metadata: {
      leadId
    }
  });

  if (existingCustomer) {
    const [updatedCustomer] = await db
      .update(schema.customers)
      .set({
        stripeCustomerId: stripeCustomer.id,
        posthogDistinctId,
        updatedAt: new Date()
      })
      .where(eq(schema.customers.id, existingCustomer.id))
      .returning();

    return updatedCustomer;
  }

  const [customer] = await db
    .insert(schema.customers)
    .values({
      leadId,
      stripeCustomerId: stripeCustomer.id,
      posthogDistinctId,
      metadata: {}
    })
    .returning();

  return customer;
}

async function resolvePromoDiscount(promoCodeInput?: string): Promise<ResolvedDiscount | null> {
  // Stripe is the only authoritative gate. If a code isn't active in Stripe
  // (deactivated, expired, max-redeemed, etc.), the lookup returns nothing and
  // no discount applies. Marketer toggles codes on/off in the Stripe Dashboard
  // — no app deploy needed to launch a new code.
  if (!promoCodeInput) return null;
  if (!isStripeConfigured()) return null;

  const promoCodes = await stripe.promotionCodes.list({
    code: promoCodeInput,
    active: true,
    limit: 1
  });
  // SDK 22.x types restructured PromotionCode.promotion.coupon, but the live
  // API still returns the legacy top-level `coupon`. Read both shapes and pick
  // whichever the runtime gave us.
  const promo = promoCodes.data[0] as
    | (typeof promoCodes.data[0] & {
        coupon?: string | { id: string; valid: boolean; percent_off: number | null };
        promotion?: {
          coupon?: string | { id: string; valid: boolean; percent_off: number | null } | null;
        };
      })
    | undefined;
  if (!promo) return null;

  const couponRef = promo.coupon ?? promo.promotion?.coupon ?? null;
  if (!couponRef) return null;
  const coupon = typeof couponRef === "string"
    ? await stripe.coupons.retrieve(couponRef)
    : couponRef;
  if (!coupon.valid || !coupon.percent_off) return null;

  return {
    promoCode: promoCodeInput,
    appliesToKind: "core",
    percentOff: coupon.percent_off
  };
}

export async function createOrUpdateCheckoutIntent(input: unknown, request?: Request) {
  const parsed = checkoutIntentInputSchema.parse(input);
  const discount = await resolvePromoDiscount(parsed.promoCode);
  const quote = buildCheckoutQuote(parsed.funnelKey, parsed.selectedBumpSkus, discount);
  const orderBumpSelected = parsed.selectedBumpSkus.length > 0;
  // Sorted hash for idempotency so toggling the same bumps in a different order
  // is still recognised as the same intent.
  const bumpKey = [...parsed.selectedBumpSkus].sort().join("+") || "base";
  const stripeReady = isStripeConfigured();

  const [lead] = await db
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.id, parsed.leadId))
    .limit(1);

  if (!lead) {
    throw new Error("Lead not found");
  }

  const [funnelSession] = await db
    .select()
    .from(schema.funnelSessions)
    .where(
      and(
        eq(schema.funnelSessions.id, parsed.funnelSessionId),
        eq(schema.funnelSessions.leadId, parsed.leadId)
      )
    )
    .limit(1);

  if (!funnelSession) {
    throw new Error("Funnel session not found");
  }

  const customer = await ensureCustomer(parsed.leadId, lead.email, lead.firstName, lead.lastName);
  // Look up existing attempt by ID first, then fall back to most-recent attempt
  // for this funnel session. The fallback handles cases where the client lost
  // the in-memory checkoutAttemptId (e.g. page refresh). Without this, Stripe's
  // idempotency would return the same PaymentIntent and INSERT would fail on
  // the unique constraint on stripe_payment_intent_id.
  const [existingAttempt] = parsed.checkoutAttemptId
    ? await db
        .select()
        .from(schema.checkoutAttempts)
        .where(eq(schema.checkoutAttempts.id, parsed.checkoutAttemptId))
        .limit(1)
    : await db
        .select()
        .from(schema.checkoutAttempts)
        .where(eq(schema.checkoutAttempts.funnelSessionId, parsed.funnelSessionId))
        .orderBy(desc(schema.checkoutAttempts.createdAt))
        .limit(1);

  let paymentIntentId: string;
  let clientSecret: string;

  if (stripeReady) {
    const candidatePaymentIntentId =
      existingAttempt?.stripePaymentIntentId && !isDemoProviderId(existingAttempt.stripePaymentIntentId)
        ? existingAttempt.stripePaymentIntentId
        : null;

    // Only PaymentIntents in pre-confirm states can have their amount updated.
    // If the previous attempt was already paid (succeeded), processing, or
    // canceled, we MUST create a fresh PI — otherwise stripe.paymentIntents.update
    // throws "amount could not be updated because it has a status of …".
    // This commonly happens when the buyer refreshes /checkout after a prior
    // successful checkout in the same browser session (stale checkoutAttemptId
    // in sessionStorage).
    let reusablePaymentIntentId: string | null = null;
    if (candidatePaymentIntentId) {
      try {
        const existingPi = await stripe.paymentIntents.retrieve(candidatePaymentIntentId);
        const reusableStatus =
          existingPi.status === "requires_payment_method" ||
          existingPi.status === "requires_confirmation" ||
          existingPi.status === "requires_action";
        // Stripe forbids changing `customer` on a PaymentIntent once set. If the
        // anon-email lead was upgraded to a real-email lead mid-flow, the
        // customer changes (different lead → different Stripe customer). In
        // that case we cancel the old PI and create a fresh one below.
        const existingCustomerId =
          typeof existingPi.customer === "string"
            ? existingPi.customer
            : existingPi.customer?.id ?? null;
        const sameCustomer =
          (existingCustomerId ?? null) === (customer.stripeCustomerId ?? null);
        if (reusableStatus && sameCustomer) {
          reusablePaymentIntentId = candidatePaymentIntentId;
        } else if (reusableStatus && !sameCustomer) {
          // Cancel the abandoned PI so it doesn't linger in the dashboard.
          // Best-effort: ignore failures (e.g., already canceled).
          await stripe.paymentIntents.cancel(candidatePaymentIntentId).catch(() => undefined);
        }
      } catch {
        // PI not found / API error — fall through to create a fresh one.
      }
    }

    // Idempotency key includes a fresh marker when we're creating a new PI for
    // an existing attempt whose previous PI was already terminal — otherwise
    // Stripe would return the same (now-frozen) PI from its idempotency cache.
    const idempotencySuffix =
      candidatePaymentIntentId && !reusablePaymentIntentId
        ? `:retry:${Date.now()}`
        : "";

    const piMetadata: Record<string, string> = {
      flow: "core",
      leadId: parsed.leadId,
      funnelSessionId: parsed.funnelSessionId,
      funnelKey: parsed.funnelKey
    };
    if (quote.discount) {
      piMetadata.promo_code = quote.discount.promoCode;
      piMetadata.promo_discount_amount = String(quote.discount.amount);
      piMetadata.promo_percent_off = String(quote.discount.percentOff);
    }

    const paymentIntent = reusablePaymentIntentId
      ? await stripe.paymentIntents.update(reusablePaymentIntentId, {
          amount: quote.totalAmount,
          currency: quote.currency,
          customer: customer.stripeCustomerId ?? undefined,
          metadata: {
            ...piMetadata,
            checkoutAttemptId: existingAttempt?.id ?? ""
          }
        })
      : await stripe.paymentIntents.create(
          {
            amount: quote.totalAmount,
            currency: quote.currency,
            customer: customer.stripeCustomerId ?? undefined,
            automatic_payment_methods: {
              enabled: true
            },
            // Scope setup_future_usage to CARD only.
            // Top-level setup_future_usage would try to set up BLIK as a recurring
            // mandate (Private Preview only) and trigger mandate UX we don't want.
            // Cards: saved → enables one-click off-session OTO/Downsell.
            // BLIK / P24: single-use → no mandate, customer enters fresh code each time.
            payment_method_options: {
              card: {
                setup_future_usage: "off_session"
              }
            },
            metadata: piMetadata
          },
          {
            idempotencyKey: `checkout-intent:${parsed.funnelSessionId}:${bumpKey}${idempotencySuffix}`
          }
        );

    paymentIntentId = paymentIntent.id;
    clientSecret = paymentIntent.client_secret ?? createDemoProviderId("secret");
  } else {
    paymentIntentId =
      existingAttempt?.stripePaymentIntentId && isDemoProviderId(existingAttempt.stripePaymentIntentId)
        ? existingAttempt.stripePaymentIntentId
        : createDemoProviderId("pi");
    clientSecret =
      typeof existingAttempt?.metadata?.demoClientSecret === "string"
        ? existingAttempt.metadata.demoClientSecret
        : createDemoProviderId("secret");
  }

  return db.transaction(async (tx) => {
    const [checkoutAttempt] =
      existingAttempt
        ? await tx
            .update(schema.checkoutAttempts)
            .set({
              // Track the LATEST funnel_session — when the buyer upgrades from
              // anon-email to a real email, /api/leads produces a fresh
              // funnel_session linked to a (possibly different) lead/customer.
              // Without this, finalizeSuccessfulCorePayment walks attempt →
              // OLD funnel_session → wrong lead/customer, and the order ends up
              // linked to a customer that doesn't own the PaymentMethod that
              // confirmed the PI. OTO/downsell off-session charges then fail
              // with "PM doesn't belong to customer".
              funnelSessionId: parsed.funnelSessionId,
              stripePaymentIntentId: paymentIntentId,
              stripeCustomerId: customer.stripeCustomerId ?? null,
              amount: quote.totalAmount,
              currency: quote.currency,
              selectedOrderBump: orderBumpSelected,
              quoteSnapshot: quote,
              status: "requires_payment_method",
              metadata: {
                ...(existingAttempt.metadata ?? {}),
                mode: stripeReady ? "stripe" : "demo",
                demoClientSecret: clientSecret
              },
              updatedAt: new Date()
            })
            .where(eq(schema.checkoutAttempts.id, existingAttempt.id))
            .returning()
        : await tx
            .insert(schema.checkoutAttempts)
            .values({
              funnelSessionId: parsed.funnelSessionId,
              stripePaymentIntentId: paymentIntentId,
              stripeCustomerId: customer.stripeCustomerId ?? null,
              amount: quote.totalAmount,
              currency: quote.currency,
              selectedOrderBump: orderBumpSelected,
              quoteSnapshot: quote,
              status: "requires_payment_method",
              metadata: {
                mode: stripeReady ? "stripe" : "demo",
                demoClientSecret: clientSecret
              }
            })
            .returning();

    await tx
      .update(schema.funnelSessions)
      .set({
        status: "checkout_started",
        priceSnapshot: quote,
        offerSnapshot: quote.offerSnapshot,
        updatedAt: new Date()
      })
      .where(eq(schema.funnelSessions.id, parsed.funnelSessionId));

    const nowIso = new Date().toISOString();

    const metaInitiate = await buildMetaOutboxEvent({
      aggregateType: "checkout_attempt",
      aggregateId: checkoutAttempt.id,
      eventScope: "initiate_checkout",
      eventKey: checkoutAttempt.id,
      eventName: "InitiateCheckout",
      eventSourceUrl: `${webEnv.PUBLIC_APP_URL}/checkout`,
      lead: {
        email: lead.email,
        phone: lead.phone,
        firstName: lead.firstName,
        lastName: lead.lastName
      },
      externalId: lead.id,
      request,
      customData: {
        currency: quote.currency,
        value: quote.totalAmount / 100,
        content_type: "product",
        content_ids: quote.items.map((item) => item.sku),
        contents: quote.items.map((item) => ({
          id: item.sku,
          quantity: item.quantity,
          item_price: item.unitAmount / 100
        })),
        num_items: quote.items.reduce((sum, item) => sum + item.quantity, 0),
        funnel_session_id: parsed.funnelSessionId,
        checkout_attempt_id: checkoutAttempt.id
      }
    });

    const quoteHash = `${quote.totalAmount}:${quote.items.map((i) => i.sku).join(",")}`;

    const distinctId = lead.anonymousId ?? `lead:${lead.id}`;
    const productsPayload = quote.items.map((item) => ({
      product_id: item.sku,
      sku: item.sku,
      name: item.name,
      category: item.kind,
      price: item.unitAmount / 100,
      quantity: item.quantity
    }));
    const totalUnits = quote.totalAmount / 100;
    const discountUnits = (quote.discount?.amount ?? 0) / 100;
    const trackingEvents = [
      buildTrackingOutboxEvent({
        aggregateType: "checkout_attempt",
        aggregateId: checkoutAttempt.id,
        dedupeKey: `posthog:Checkout Started:${checkoutAttempt.id}`,
        event: {
          event: "Checkout Started",
          eventId: `Checkout Started:${checkoutAttempt.id}`,
          distinctId,
          anonymousId: lead.anonymousId ?? undefined,
          timestamp: nowIso,
          properties: {
            checkout_id: checkoutAttempt.id,
            order_id: checkoutAttempt.id,
            affiliation: "stripe",
            currency: quote.currency,
            value: totalUnits,
            revenue: totalUnits,
            total: totalUnits,
            discount: discountUnits,
            coupon: quote.discount?.promoCode ?? null,
            funnel_session_id: parsed.funnelSessionId,
            funnel_key: parsed.funnelKey,
            lead_id: lead.id,
            order_bump_selected: orderBumpSelected,
            selected_bump_skus: parsed.selectedBumpSkus,
            products: productsPayload
          }
        }
      })
    ];
    if (quote.discount) {
      trackingEvents.push(
        buildTrackingOutboxEvent({
          aggregateType: "checkout_attempt",
          aggregateId: checkoutAttempt.id,
          dedupeKey: `posthog:Coupon Applied:${checkoutAttempt.id}:${quote.discount.promoCode}`,
          event: {
            event: "Coupon Applied",
            eventId: `Coupon Applied:${checkoutAttempt.id}:${quote.discount.promoCode}`,
            distinctId,
            anonymousId: lead.anonymousId ?? undefined,
            timestamp: nowIso,
            properties: {
              order_id: checkoutAttempt.id,
              cart_id: parsed.funnelSessionId,
              coupon_id: quote.discount.promoCode,
              coupon_name: quote.discount.promoCode,
              discount: discountUnits
            }
          }
        })
      );
    } else if (parsed.promoCode) {
      // User passed ?promo= but Stripe rejected (inactive/expired/max-redeemed).
      trackingEvents.push(
        buildTrackingOutboxEvent({
          aggregateType: "checkout_attempt",
          aggregateId: checkoutAttempt.id,
          dedupeKey: `posthog:Coupon Denied:${checkoutAttempt.id}:${parsed.promoCode}`,
          event: {
            event: "Coupon Denied",
            eventId: `Coupon Denied:${checkoutAttempt.id}:${parsed.promoCode}`,
            distinctId,
            anonymousId: lead.anonymousId ?? undefined,
            timestamp: nowIso,
            properties: {
              order_id: checkoutAttempt.id,
              cart_id: parsed.funnelSessionId,
              coupon_id: parsed.promoCode,
              reason: "stripe_rejected_or_inactive"
            }
          }
        })
      );
    }

    await enqueueOutboxEvents(tx, [
      ...trackingEvents,
      metaInitiate.outbox,
      buildMailerliteOutboxEvent({
        aggregateType: "checkout_attempt",
        aggregateId: checkoutAttempt.id,
        // Different bump selections produce a different hash, so toggling
        // bumps mid-flow re-pushes the cart instead of being deduped away.
        dedupeKey: `mailerlite:cart:${checkoutAttempt.id}:${quoteHash}`,
        eventName: "cart.upsert",
        payload: {
          id: checkoutAttempt.id,
          email: lead.email,
          currency: quote.currency,
          total: quote.totalAmount / 100,
          items: quote.items.map((item) => ({
            product_id: item.sku,
            name: item.name,
            price: item.unitAmount / 100,
            quantity: item.quantity,
            url: `${webEnv.PUBLIC_APP_URL}/checkout`
          }))
        }
      })
    ]);

    return checkoutIntentResponseSchema.parse({
      checkoutAttemptId: checkoutAttempt.id,
      paymentIntentId,
      clientSecret,
      quote,
      metaEventIds: {
        initiateCheckout: metaInitiate.eventId
      }
    });
  });
}
