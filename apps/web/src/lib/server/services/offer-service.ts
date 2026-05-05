import { and, eq, sql } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import {
  metaEventId,
  offerDecisionResponseSchema,
  offerTokenPayloadSchema,
  type OfferTokenPayload
} from "@agentic-funnel/shared";
import { sha256, signOfferToken, verifyOfferToken } from "@agentic-funnel/shared/crypto";

import { getOfferFromFunnel } from "../../config/funnels";
import { stripeSlots } from "../../config/funnels.generated";
import { db, type AppDbTx } from "../db";
import { stripe } from "../integrations/stripe";
import { webEnv } from "../env";
import {
  createDemoProviderId,
  isDemoProviderId,
  isStripeConfigured
} from "../utils/providers";
import { finalizeOrderAndQueueFulfillment } from "./order-service";
import {
  buildHyrosOrderOutboxEvent,
  buildMailerliteOutboxEvent,
  buildMetaOutboxEvent,
  buildTrackingOutboxEvent,
  enqueueOutboxEvents
} from "./outbox-service";
import { firePurchaseIfTerminal } from "./purchase-settler";
import type { SlotAsset } from "../../config/funnels";

function offerKindToNotBoughtGroupKey(kind: "oto" | "downsell"): string {
  return kind === "oto" ? "leads_not_bought_oto" : "leads_not_bought_downsell";
}

type OfferData = {
  sku: string;
  name: string;
  unitAmount: number;
  /** R2 object key from Stripe Product metadata.r2_key. */
  r2Key?: string | null;
  /** Multi-file delivery (each signed at fulfillment time). Wins over r2Key. */
  assets?: SlotAsset[];
};

async function issueOfferToken(tx: AppDbTx, payload: OfferTokenPayload) {
  const token = signOfferToken(offerTokenPayloadSchema.parse(payload), webEnv.APP_SIGNING_SECRET);
  await tx
    .update(schema.postPurchaseOfferInstances)
    .set({
      offerTokenHash: sha256(token),
      tokenIssuedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(schema.postPurchaseOfferInstances.id, payload.offerInstanceId));

  return token;
}

async function loadOfferContext(token: string) {
  const payload = verifyOfferToken(token, webEnv.APP_SIGNING_SECRET);
  const [offer] = await db
    .select()
    .from(schema.postPurchaseOfferInstances)
    .where(eq(schema.postPurchaseOfferInstances.id, payload.offerInstanceId))
    .limit(1);

  if (!offer) {
    throw new Error("Offer not found");
  }

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, offer.orderId))
    .limit(1);

  if (!order) {
    throw new Error("Order not found");
  }

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, order.customerId))
    .limit(1);

  const [lead] = customer
    ? await db.select().from(schema.leads).where(eq(schema.leads.id, customer.leadId)).limit(1)
    : [undefined];

  const [corePayment] = await db
    .select()
    .from(schema.paymentRecords)
    .where(and(eq(schema.paymentRecords.orderId, order.id), eq(schema.paymentRecords.type, "core")))
    .limit(1);

  return {
    payload,
    offer,
    order,
    customer,
    lead,
    corePayment
  };
}

type OfferContextLite = {
  offer: { id: string; type: "oto" | "downsell" };
  order: { id: string; funnelSessionId: string; currency: string; funnelKey: string | null };
  lead?: {
    id: string;
    email: string;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    anonymousId: string | null;
  };
};

function distinctIdForOfferContext(ctx: OfferContextLite) {
  return ctx.lead?.anonymousId ?? `lead:${ctx.lead?.id ?? ctx.order.id}`;
}

function readFunnelKeyFromOrder(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const fk = (metadata as { funnelKey?: unknown }).funnelKey;
  return typeof fk === "string" && fk.length > 0 ? fk : null;
}

type OfferMetaEventName =
  | "OTO_Viewed"
  | "OTO_Accepted"
  | "OTO_Rejected"
  | "Downsell_Viewed"
  | "Downsell_Accepted"
  | "Downsell_Rejected";

function offerMetaEventName(
  offerType: "oto" | "downsell",
  action: "Viewed" | "Accepted" | "Rejected"
): OfferMetaEventName {
  return offerType === "oto" ? (`OTO_${action}` as const) : (`Downsell_${action}` as const);
}

function offerMetaScope(eventName: OfferMetaEventName): string {
  return eventName.toLowerCase();
}

async function buildOfferMetaOutbox(
  ctx: OfferContextLite,
  eventName: OfferMetaEventName,
  customDataExtra?: Record<string, unknown>,
  request?: Request
) {
  return buildMetaOutboxEvent({
    aggregateType: "offer",
    aggregateId: ctx.offer.id,
    eventScope: offerMetaScope(eventName),
    eventKey: ctx.offer.id,
    eventName,
    eventSourceUrl: `${webEnv.PUBLIC_APP_URL}/${ctx.offer.type === "oto" ? "oto" : "downsell"}`,
    lead: ctx.lead
      ? {
          email: ctx.lead.email,
          phone: ctx.lead.phone,
          firstName: ctx.lead.firstName,
          lastName: ctx.lead.lastName
        }
      : undefined,
    externalId: ctx.lead?.id,
    request,
    customData: {
      currency: ctx.order.currency,
      funnel_session_id: ctx.order.funnelSessionId,
      order_id: ctx.order.id,
      ...customDataExtra
    }
  });
}

export async function issueOfferTokenForOfferInstance(offerInstanceId: string) {
  const [offer] = await db
    .select()
    .from(schema.postPurchaseOfferInstances)
    .where(eq(schema.postPurchaseOfferInstances.id, offerInstanceId))
    .limit(1);

  if (!offer) {
    throw new Error("Offer not found");
  }

  return db.transaction(async (tx) => {
    return issueOfferToken(tx, {
      version: 1,
      orderId: offer.orderId,
      funnelSessionId: offer.funnelSessionId,
      offerInstanceId: offer.id,
      offerType: offer.type,
      issuedAt: new Date().toISOString(),
      expiresAt: offer.expiresAt.toISOString()
    });
  });
}

export async function getOfferPageData(token: string, request?: Request) {
  const context = await loadOfferContext(token);
  const offerData = context.offer.offerData as OfferData;

  const metaContext: OfferContextLite = {
    offer: { id: context.offer.id, type: context.offer.type },
    order: {
      id: context.order.id,
      funnelSessionId: context.order.funnelSessionId,
      currency: context.order.currency,
      funnelKey: readFunnelKeyFromOrder(context.order.metadata)
    },
    lead: context.lead
      ? {
          id: context.lead.id,
          email: context.lead.email,
          phone: context.lead.phone,
          firstName: context.lead.firstName,
          lastName: context.lead.lastName,
          anonymousId: context.lead.anonymousId ?? null
        }
      : undefined
  };

  const eventName = offerMetaEventName(context.offer.type, "Viewed");
  const meta = await buildOfferMetaOutbox(
    metaContext,
    eventName,
    {
      content_type: "product",
      content_ids: [offerData.sku],
      content_name: offerData.name,
      value: offerData.unitAmount / 100,
      offer_token: token
    },
    request
  );

  await db.transaction(async (tx) => {
    await enqueueOutboxEvents(tx, [meta.outbox]);
  });

  return {
    orderId: context.order.id,
    funnelSessionId: context.order.funnelSessionId,
    funnelKey: readFunnelKeyFromOrder(context.order.metadata),
    offerInstanceId: context.offer.id,
    offerType: context.offer.type,
    status: context.offer.status,
    token,
    expiresAt: context.offer.expiresAt.toISOString(),
    currency: context.order.currency,
    offer: offerData,
    metaEventId: meta.eventId,
    // Needed client-side for Stripe.js confirmBlikPayment / confirmP24Payment
    // billing_details when the buyer's saved PM is single-use.
    buyerEmail: context.lead?.email ?? ""
  };
}

/** Dev-only: synthesize an offer page payload from funnel config (no DB, no token).
 *  Lets us preview the OTO/downsell page without going through Stripe checkout. */
export function getPreviewOfferPageData(
  kind: "oto" | "downsell",
  funnelKey = "starter-funnel"
): Awaited<ReturnType<typeof getOfferPageData>> {
  const fromFunnel = getOfferFromFunnel(funnelKey, kind);
  const slot = stripeSlots[kind === "oto" ? "OTO" : "DOWNSELL"];
  if (!fromFunnel && !slot) {
    throw new Error(`No ${kind} slot configured in Stripe`);
  }

  return {
    orderId: "preview-order",
    funnelSessionId: "preview-session",
    funnelKey,
    offerInstanceId: "preview-offer",
    offerType: kind,
    status: "presented",
    token: "preview",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    currency: fromFunnel ? "pln" : (slot?.currency ?? "pln"),
    offer: {
      sku: fromFunnel?.sku ?? `preview-${kind}`,
      name: fromFunnel?.name ?? slot!.name,
      unitAmount: fromFunnel?.unitAmount ?? slot!.unitAmount,
      r2Key: fromFunnel?.r2Key ?? slot?.r2Key ?? null,
      assets: fromFunnel?.assets
    },
    metaEventId: "preview",
    buyerEmail: ""
  };
}

async function finalizeAcceptedOffer(input: {
  offerId: string;
  orderId: string;
  funnelSessionId: string;
  paymentIntentId: string;
  paymentMethodId?: string | null;
  amount: number;
  currency: string;
  metaContext: OfferContextLite;
  metaCustomData: Record<string, unknown>;
  request?: Request;
}) {
  const metaEvent = await buildOfferMetaOutbox(
    input.metaContext,
    offerMetaEventName(input.metaContext.offer.type, "Accepted"),
    input.metaCustomData,
    input.request
  );

  return db.transaction(async (tx) => {
    await tx
      .update(schema.postPurchaseOfferInstances)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        decisionSource: "click_accept",
        updatedAt: new Date()
      })
      .where(eq(schema.postPurchaseOfferInstances.id, input.offerId));

    await tx
      .insert(schema.paymentRecords)
      .values({
        orderId: input.orderId,
        offerInstanceId: input.offerId,
        stripePaymentIntentId: input.paymentIntentId,
        stripePaymentMethodId: input.paymentMethodId ?? null,
        type: "upsell",
        amount: input.amount,
        currency: input.currency,
        status: "succeeded",
        metadata: {}
      })
      .onConflictDoNothing({ target: schema.paymentRecords.stripePaymentIntentId });

    const [offer] = await tx
      .select()
      .from(schema.postPurchaseOfferInstances)
      .where(eq(schema.postPurchaseOfferInstances.id, input.offerId))
      .limit(1);

    const offerData = offer.offerData as OfferData;

    await tx.insert(schema.orderLines).values({
      orderId: input.orderId,
      sourceOfferInstanceId: input.offerId,
      kind: offer.type,
      sku: offerData.sku,
      name: offerData.name,
      quantity: 1,
      unitAmount: offerData.unitAmount,
      totalAmount: offerData.unitAmount,
      assetBundleId: null,
      metadata: {
        ...(offerData.r2Key ? { r2Key: offerData.r2Key } : {}),
        ...(offerData.assets && offerData.assets.length > 0
          ? { assets: offerData.assets }
          : {})
      }
    });

    await tx
      .update(schema.orders)
      .set({
        totalAmount: sql`${schema.orders.totalAmount} + ${input.amount}`,
        updatedAt: new Date()
      })
      .where(eq(schema.orders.id, input.orderId));

    const mlEmail = input.metaContext.lead?.email;
    const mlEvents = mlEmail
      ? [
          buildMailerliteOutboxEvent({
            aggregateType: "offer",
            aggregateId: input.offerId,
            dedupeKey: `mailerlite:offer-accept:${input.offerId}`,
            eventName: "subscriber.group.unassign",
            payload: {
              email: mlEmail,
              groupKey: offerKindToNotBoughtGroupKey(input.metaContext.offer.type)
            }
          }),
          buildMailerliteOutboxEvent({
            aggregateType: "order",
            aggregateId: input.orderId,
            dedupeKey: `mailerlite:order-update:${input.offerId}`,
            eventName: "order.upsert",
            payload: {
              id: input.orderId,
              email: mlEmail,
              currency: input.currency,
              total: input.amount / 100,
              status: "complete",
              items: [
                {
                  product_id: offerData.sku,
                  name: offerData.name,
                  price: offerData.unitAmount / 100,
                  quantity: 1
                }
              ]
            }
          })
        ]
      : [];

    const offerKind = input.metaContext.offer.type;
    const distinctId = distinctIdForOfferContext(input.metaContext);
    const amountUnits = input.amount / 100;
    const nowIso = new Date().toISOString();
    const appHost = new URL(webEnv.PUBLIC_APP_URL).hostname;

    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "offer",
        aggregateId: input.offerId,
        // PI-keyed dedupe so retried Stripe webhook deliveries don't double-
        // count revenue in PostHog Revenue Analytics.
        dedupeKey: `posthog:Order Completed:offer:${input.offerId}:pi:${input.paymentIntentId}`,
        event: {
          event: "Order Completed",
          eventId: `Order Completed:pi:${input.paymentIntentId}`,
          distinctId,
          anonymousId: input.metaContext.lead?.anonymousId ?? undefined,
          timestamp: nowIso,
          properties: {
            // Spec: order_id is the parent order. offer_instance_id is our
            // internal handle for the specific upsell decision.
            order_id: input.orderId,
            checkout_id: input.offerId,
            offer_instance_id: input.offerId,
            affiliation: "stripe",
            total: amountUnits,
            subtotal: amountUnits,
            revenue: amountUnits,
            shipping: 0,
            tax: 0,
            discount: 0,
            coupon: null,
            currency: input.currency,
            offer_kind: offerKind,
            parent_order_id: input.orderId,
            funnel_session_id: input.funnelSessionId,
            funnel_key: input.metaContext.order.funnelKey,
            lead_id: input.metaContext.lead?.id ?? null,
            stripe_payment_intent_id: input.paymentIntentId,
            host: appHost,
            app_source: "astro_native",
            products: [
              {
                product_id: offerData.sku,
                sku: offerData.sku,
                name: offerData.name,
                category: offerKind,
                price: offerData.unitAmount / 100,
                quantity: 1
              }
            ]
          },
          set: {
            last_purchase_at: nowIso,
            last_seen_at: nowIso,
            ...(input.metaContext.order.funnelKey
              ? { funnel_key: input.metaContext.order.funnelKey }
              : {})
          }
        }
      }),
      metaEvent.outbox,
      // Hyros — second sale on the same parent orderId so Hyros groups core +
      // OTO/downsell as one customer journey. Dedupe on the offer's PI so
      // retried Stripe webhook deliveries don't post duplicate upsell sales.
      ...(input.metaContext.lead?.email
        ? [
            buildHyrosOrderOutboxEvent({
              aggregateType: "offer",
              aggregateId: input.offerId,
              dedupeKey: `hyros:order:${input.orderId}:offer:${input.offerId}:pi:${input.paymentIntentId}`,
              payload: {
                email: input.metaContext.lead.email,
                firstName: input.metaContext.lead.firstName ?? undefined,
                lastName: input.metaContext.lead.lastName ?? undefined,
                phoneNumbers: input.metaContext.lead.phone
                  ? [input.metaContext.lead.phone]
                  : undefined,
                orderId: input.orderId,
                date: nowIso,
                currency: input.currency.toUpperCase(),
                priceFormat: "DECIMAL",
                items: [
                  {
                    name: offerData.name,
                    price: input.amount / 100,
                    quantity: 1,
                    externalId: offerData.sku,
                    tag: offerKind
                  }
                ]
              }
            })
          ]
        : []),
      ...mlEvents
    ]);

    await finalizeOrderAndQueueFulfillment(tx, {
      orderId: input.orderId,
      funnelSessionId: input.funnelSessionId,
      reason: "accepted"
    });
  });
}

export async function acceptOffer(token: string, request?: Request) {
  const context = await loadOfferContext(token);

  if (context.offer.status !== "presented") {
    return offerDecisionResponseSchema.parse({
      status: context.offer.status,
      nextStep: "thank_you",
      orderId: context.order.id
    });
  }

  const stripeReady = isStripeConfigured();
  const hasDemoPaymentContext =
    isDemoProviderId(context.customer?.stripeCustomerId) ||
    isDemoProviderId(context.corePayment?.stripePaymentMethodId);
  const savedPaymentMethodId =
    context.corePayment?.stripePaymentMethodId ??
    (!stripeReady ? createDemoProviderId("pm") : null);

  if (stripeReady && (!context.customer?.stripeCustomerId || !savedPaymentMethodId)) {
    throw new Error("Saved payment method missing for post-purchase offer");
  }

  const offerData = context.offer.offerData as OfferData;

  const metaContext: OfferContextLite = {
    offer: { id: context.offer.id, type: context.offer.type },
    order: {
      id: context.order.id,
      funnelSessionId: context.order.funnelSessionId,
      currency: context.order.currency,
      funnelKey: readFunnelKeyFromOrder(context.order.metadata)
    },
    lead: context.lead
      ? {
          id: context.lead.id,
          email: context.lead.email,
          phone: context.lead.phone,
          firstName: context.lead.firstName,
          lastName: context.lead.lastName,
          anonymousId: context.lead.anonymousId ?? null
        }
      : undefined
  };
  const metaCustomData = {
    content_type: "product",
    content_ids: [offerData.sku],
    content_name: offerData.name,
    value: offerData.unitAmount / 100,
    offer_token: token
  };
  const acceptedMetaEventId = metaEventId(
    offerMetaScope(offerMetaEventName(context.offer.type, "Accepted")),
    context.offer.id
  );

  if (!stripeReady || hasDemoPaymentContext) {
    await finalizeAcceptedOffer({
      offerId: context.offer.id,
      orderId: context.order.id,
      funnelSessionId: context.order.funnelSessionId,
      paymentIntentId: createDemoProviderId("pi"),
      paymentMethodId: savedPaymentMethodId,
      amount: offerData.unitAmount,
      currency: context.order.currency,
      metaContext,
      metaCustomData,
      request
    });

    const purchase = await firePurchaseIfTerminal(context.order.id, request);

    return offerDecisionResponseSchema.parse({
      status: "accepted",
      nextStep: "thank_you",
      orderId: context.order.id,
      metaEventId: acceptedMetaEventId,
      purchaseMetaEventId: purchase?.eventId,
      purchaseValue: purchase?.value,
      purchaseCurrency: purchase?.currency,
      purchaseContents: purchase?.contents,
      purchaseNumItems: purchase?.numItems
    });
  }

  // The buyer's saved PaymentMethod tells us how they originally paid. BLIK
  // and P24 are single-use → can't be charged off_session. Re-prompt the
  // buyer with the same method (fresh BLIK code / P24 bank pick). Cards
  // continue down the off_session path below.
  const savedPaymentMethod = savedPaymentMethodId
    ? await stripe.paymentMethods.retrieve(savedPaymentMethodId).catch(() => null)
    : null;
  const savedPmType = savedPaymentMethod?.type ?? "card";

  if (savedPmType === "blik" || savedPmType === "p24") {
    const deferredPi = await stripe.paymentIntents.create(
      {
        amount: offerData.unitAmount,
        currency: context.order.currency,
        customer: context.customer?.stripeCustomerId ?? undefined,
        payment_method_types: [savedPmType],
        // confirm: false — client mounts BLIK popup or P24 redirect via Stripe.js,
        // bank confirms async, webhook (flow=offer) finalizes the offer instance.
        metadata: {
          flow: "offer",
          offerInstanceId: context.offer.id,
          orderId: context.order.id,
          funnelSessionId: context.order.funnelSessionId,
          offerType: context.offer.type
        }
      },
      {
        idempotencyKey: `offer_accept_${savedPmType}:${context.offer.id}`
      }
    );

    if (!deferredPi.client_secret) {
      throw new Error("Stripe did not return a client_secret for the offer PaymentIntent");
    }

    return offerDecisionResponseSchema.parse({
      status: context.offer.status,
      nextStep: "thank_you",
      orderId: context.order.id,
      paymentAction: {
        method: savedPmType,
        clientSecret: deferredPi.client_secret,
        paymentIntentId: deferredPi.id
      }
    });
  }

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: offerData.unitAmount,
      currency: context.order.currency,
      customer: context.customer?.stripeCustomerId ?? undefined,
      payment_method: savedPaymentMethodId ?? undefined,
      confirm: true,
      off_session: true,
      metadata: {
        flow: "offer",
        offerInstanceId: context.offer.id,
        orderId: context.order.id,
        funnelSessionId: context.order.funnelSessionId,
        offerType: context.offer.type
      }
    },
    {
      idempotencyKey: `offer_accept:${context.offer.id}`
    }
  );

  if (paymentIntent.status !== "succeeded") {
    const failed = await db.transaction(async (tx) => {
      await tx
        .update(schema.postPurchaseOfferInstances)
        .set({
          status: "charge_failed",
          failedAt: new Date(),
          decisionSource: paymentIntent.status,
          updatedAt: new Date()
        })
        .where(eq(schema.postPurchaseOfferInstances.id, context.offer.id));

      await finalizeOrderAndQueueFulfillment(tx, {
        orderId: context.order.id,
        funnelSessionId: context.order.funnelSessionId,
        reason: "charge_failed"
      });

      return offerDecisionResponseSchema.parse({
        status: "charge_failed",
        nextStep: "thank_you",
        orderId: context.order.id
      });
    });

    const purchase = await firePurchaseIfTerminal(context.order.id, request);
    return offerDecisionResponseSchema.parse({
      ...failed,
      purchaseMetaEventId: purchase?.eventId,
      purchaseValue: purchase?.value,
      purchaseCurrency: purchase?.currency,
      purchaseContents: purchase?.contents,
      purchaseNumItems: purchase?.numItems
    });
  }

  await finalizeAcceptedOffer({
    offerId: context.offer.id,
    orderId: context.order.id,
    funnelSessionId: context.order.funnelSessionId,
    paymentIntentId: paymentIntent.id,
    paymentMethodId: typeof paymentIntent.payment_method === "string" ? paymentIntent.payment_method : null,
    amount: offerData.unitAmount,
    currency: context.order.currency,
    metaContext,
    metaCustomData,
    request
  });

  const purchase = await firePurchaseIfTerminal(context.order.id, request);

  return offerDecisionResponseSchema.parse({
    status: "accepted",
    nextStep: "thank_you",
    orderId: context.order.id,
    metaEventId: acceptedMetaEventId,
    purchaseMetaEventId: purchase?.eventId,
    purchaseValue: purchase?.value,
    purchaseCurrency: purchase?.currency,
    purchaseContents: purchase?.contents,
    purchaseNumItems: purchase?.numItems
  });
}

export async function declineOffer(token: string, request?: Request) {
  const context = await loadOfferContext(token);

  if (context.offer.status !== "presented") {
    return offerDecisionResponseSchema.parse({
      status: context.offer.status,
      nextStep: "thank_you",
      orderId: context.order.id
    });
  }

  const metaContext: OfferContextLite = {
    offer: { id: context.offer.id, type: context.offer.type },
    order: {
      id: context.order.id,
      funnelSessionId: context.order.funnelSessionId,
      currency: context.order.currency,
      funnelKey: readFunnelKeyFromOrder(context.order.metadata)
    },
    lead: context.lead
      ? {
          id: context.lead.id,
          email: context.lead.email,
          phone: context.lead.phone,
          firstName: context.lead.firstName,
          lastName: context.lead.lastName,
          anonymousId: context.lead.anonymousId ?? null
        }
      : undefined
  };
  const offerData = context.offer.offerData as OfferData;
  const rejectedMetaCustomData = {
    content_type: "product" as const,
    content_ids: [offerData.sku],
    content_name: offerData.name,
    value: offerData.unitAmount / 100,
    offer_token: token
  };

  const rejectedMeta = await buildOfferMetaOutbox(
    metaContext,
    offerMetaEventName(context.offer.type, "Rejected"),
    rejectedMetaCustomData,
    request
  );

  if (context.offer.type === "oto") {
    const orderMetadata = context.order.metadata as { funnelKey?: string };
    const downsell = getOfferFromFunnel(orderMetadata.funnelKey ?? "starter-funnel", "downsell");

    // No downsell slot configured → mark OTO declined and finalize straight to
    // thank_you. Same shape as the bottom-of-funnel downsell-declined branch.
    if (!downsell) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.postPurchaseOfferInstances)
          .set({
            status: "declined",
            declinedAt: new Date(),
            decisionSource: "click_decline",
            updatedAt: new Date()
          })
          .where(eq(schema.postPurchaseOfferInstances.id, context.offer.id));

        await enqueueOutboxEvents(tx, [
          buildTrackingOutboxEvent({
            aggregateType: "offer",
            aggregateId: context.offer.id,
            dedupeKey: `posthog:Offer Declined:${context.offer.id}`,
            event: {
              event: "Offer Declined",
              eventId: `Offer Declined:${context.offer.id}`,
              distinctId: distinctIdForOfferContext(metaContext),
              anonymousId: context.lead?.anonymousId ?? undefined,
              timestamp: new Date().toISOString(),
              properties: {
                offer_kind: "oto",
                offer_instance_id: context.offer.id,
                order_id: context.order.id,
                funnel_session_id: context.order.funnelSessionId,
                funnel_key: metaContext.order.funnelKey,
                product_id: offerData.sku,
                price: offerData.unitAmount / 100,
                currency: context.order.currency
              }
            }
          }),
          rejectedMeta.outbox,
          ...(context.lead
            ? [
                buildMailerliteOutboxEvent({
                  aggregateType: "offer",
                  aggregateId: context.offer.id,
                  // Shared with the expiry path so a decline-then-expire (or
                  // vice versa) resolves to a single group assignment.
                  dedupeKey: `mailerlite:offer-skip:${context.offer.id}`,
                  eventName: "subscriber.group.assign",
                  payload: {
                    email: context.lead.email,
                    groupKey: offerKindToNotBoughtGroupKey("oto")
                  }
                })
              ]
            : [])
        ]);

        await finalizeOrderAndQueueFulfillment(tx, {
          orderId: context.order.id,
          funnelSessionId: context.order.funnelSessionId,
          reason: "declined"
        });
      });

      const purchase = await firePurchaseIfTerminal(context.order.id, request);
      return offerDecisionResponseSchema.parse({
        status: "declined",
        nextStep: "thank_you",
        orderId: context.order.id,
        metaEventId: rejectedMeta.eventId,
        purchaseMetaEventId: purchase?.eventId,
        purchaseValue: purchase?.value,
        purchaseCurrency: purchase?.currency,
        purchaseContents: purchase?.contents,
        purchaseNumItems: purchase?.numItems
      });
    }

    const otoResult = await db.transaction(async (tx) => {
      await tx
        .update(schema.postPurchaseOfferInstances)
        .set({
          status: "declined",
          declinedAt: new Date(),
          decisionSource: "click_decline",
          updatedAt: new Date()
        })
        .where(eq(schema.postPurchaseOfferInstances.id, context.offer.id));

      const downsellOfferData: OfferData = {
        sku: downsell.sku,
        name: downsell.name,
        unitAmount: downsell.unitAmount,
        r2Key: downsell.r2Key,
        ...(downsell.assets ? { assets: downsell.assets } : {})
      };
      const [downsellInstance] = await tx
        .insert(schema.postPurchaseOfferInstances)
        .values({
          orderId: context.order.id,
          funnelSessionId: context.order.funnelSessionId,
          parentOfferInstanceId: context.offer.id,
          type: "downsell",
          status: "presented",
          offerData: downsellOfferData,
          expiresAt: context.offer.expiresAt
        })
        .returning();

      const nextToken = await issueOfferToken(tx, {
        version: 1,
        orderId: context.order.id,
        funnelSessionId: context.order.funnelSessionId,
        offerInstanceId: downsellInstance.id,
        offerType: "downsell",
        issuedAt: new Date().toISOString(),
        expiresAt: downsellInstance.expiresAt.toISOString()
      });

      await enqueueOutboxEvents(tx, [
        buildTrackingOutboxEvent({
          aggregateType: "offer",
          aggregateId: context.offer.id,
          dedupeKey: `posthog:Offer Declined:${context.offer.id}`,
          event: {
            event: "Offer Declined",
            eventId: `Offer Declined:${context.offer.id}`,
            distinctId: distinctIdForOfferContext(metaContext),
            anonymousId: context.lead?.anonymousId ?? undefined,
            timestamp: new Date().toISOString(),
            properties: {
              offer_kind: "oto",
              offer_instance_id: context.offer.id,
              order_id: context.order.id,
              funnel_session_id: context.order.funnelSessionId,
              funnel_key: metaContext.order.funnelKey,
              product_id: offerData.sku,
              price: offerData.unitAmount / 100,
              currency: context.order.currency
            }
          }
        }),
        rejectedMeta.outbox,
        ...(context.lead
          ? [
              buildMailerliteOutboxEvent({
                aggregateType: "offer",
                aggregateId: context.offer.id,
                dedupeKey: `mailerlite:offer-skip:${context.offer.id}`,
                eventName: "subscriber.group.assign",
                payload: {
                  email: context.lead.email,
                  groupKey: offerKindToNotBoughtGroupKey("oto")
                }
              })
            ]
          : [])
      ]);

      return { nextToken };
    });

    return offerDecisionResponseSchema.parse({
      status: "declined",
      nextStep: "downsell",
      nextToken: otoResult.nextToken,
      orderId: context.order.id,
      metaEventId: rejectedMeta.eventId
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(schema.postPurchaseOfferInstances)
      .set({
        status: "declined",
        declinedAt: new Date(),
        decisionSource: "click_decline",
        updatedAt: new Date()
      })
      .where(eq(schema.postPurchaseOfferInstances.id, context.offer.id));

    await enqueueOutboxEvents(tx, [
      buildTrackingOutboxEvent({
        aggregateType: "offer",
        aggregateId: context.offer.id,
        dedupeKey: `posthog:Offer Declined:${context.offer.id}`,
        event: {
          event: "Offer Declined",
          eventId: `Offer Declined:${context.offer.id}`,
          distinctId: distinctIdForOfferContext(metaContext),
          anonymousId: context.lead?.anonymousId ?? undefined,
          timestamp: new Date().toISOString(),
          properties: {
            offer_kind: "downsell",
            offer_instance_id: context.offer.id,
            order_id: context.order.id,
            funnel_session_id: context.order.funnelSessionId,
            funnel_key: metaContext.order.funnelKey,
            product_id: offerData.sku,
            price: offerData.unitAmount / 100,
            currency: context.order.currency
          }
        }
      }),
      rejectedMeta.outbox,
      ...(context.lead
        ? [
            buildMailerliteOutboxEvent({
              aggregateType: "offer",
              aggregateId: context.offer.id,
              dedupeKey: `mailerlite:offer-skip:${context.offer.id}`,
              eventName: "subscriber.group.assign",
              payload: {
                email: context.lead.email,
                groupKey: offerKindToNotBoughtGroupKey("downsell")
              }
            })
          ]
        : [])
    ]);

    await finalizeOrderAndQueueFulfillment(tx, {
      orderId: context.order.id,
      funnelSessionId: context.order.funnelSessionId,
      reason: "declined"
    });
  });

  const purchase = await firePurchaseIfTerminal(context.order.id, request);

  return offerDecisionResponseSchema.parse({
    status: "declined",
    nextStep: "thank_you",
    orderId: context.order.id,
    metaEventId: rejectedMeta.eventId,
    purchaseMetaEventId: purchase?.eventId,
    purchaseValue: purchase?.value,
    purchaseCurrency: purchase?.currency,
    purchaseContents: purchase?.contents,
    purchaseNumItems: purchase?.numItems
  });
}

export async function createInitialOfferInstance(input: {
  orderId: string;
  funnelSessionId: string;
  funnelKey: string;
  expiresAt: Date;
}) {
  const oto = getOfferFromFunnel(input.funnelKey, "oto");
  if (!oto) {
    // STRIPE_PRICE_OTO unset → no upsell to present. Caller falls through to
    // /thank-you/[orderId] when checkout-status sees no `presented` offer.
    return null;
  }

  const otoOfferData: OfferData = {
    sku: oto.sku,
    name: oto.name,
    unitAmount: oto.unitAmount,
    r2Key: oto.r2Key,
    ...(oto.assets ? { assets: oto.assets } : {})
  };

  return db.transaction(async (tx) => {
    const [offerInstance] = await tx
      .insert(schema.postPurchaseOfferInstances)
      .values({
        orderId: input.orderId,
        funnelSessionId: input.funnelSessionId,
        type: "oto",
        status: "presented",
        offerData: otoOfferData,
        expiresAt: input.expiresAt
      })
      .returning();

    const token = await issueOfferToken(tx, {
      version: 1,
      orderId: input.orderId,
      funnelSessionId: input.funnelSessionId,
      offerInstanceId: offerInstance.id,
      offerType: "oto",
      issuedAt: new Date().toISOString(),
      expiresAt: input.expiresAt.toISOString()
    });

    return {
      offerInstanceId: offerInstance.id,
      token
    };
  });
}

/**
 * Webhook entry point for `payment_intent.succeeded` with metadata.flow="offer".
 * Used for BLIK/P24 offer accepts where the synchronous acceptOffer path
 * couldn't confirm off_session and instead returned a deferred PI for the
 * client to confirm via Stripe.js. Also covers 3DS-delayed card confirmations.
 *
 * Idempotent: if the offer has already been finalized (accepted/charge_failed),
 * this returns without re-running the side effects.
 */
export async function finalizeOfferFromPaymentIntent(paymentIntent: {
  id: string;
  amount: number;
  currency: string;
  payment_method: string | null;
  metadata: Record<string, string | undefined>;
}) {
  const offerInstanceId = paymentIntent.metadata.offerInstanceId;
  if (!offerInstanceId) return;

  const [offer] = await db
    .select()
    .from(schema.postPurchaseOfferInstances)
    .where(eq(schema.postPurchaseOfferInstances.id, offerInstanceId))
    .limit(1);

  if (!offer) return;
  if (offer.status === "accepted" || offer.status === "charge_failed") return;

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, offer.orderId))
    .limit(1);

  if (!order) return;

  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, order.customerId))
    .limit(1);

  const [lead] = customer
    ? await db.select().from(schema.leads).where(eq(schema.leads.id, customer.leadId)).limit(1)
    : [undefined];

  const offerData = offer.offerData as OfferData;

  const metaContext: OfferContextLite = {
    offer: { id: offer.id, type: offer.type },
    order: {
      id: order.id,
      funnelSessionId: order.funnelSessionId,
      currency: order.currency,
      funnelKey: readFunnelKeyFromOrder(order.metadata)
    },
    lead: lead
      ? {
          id: lead.id,
          email: lead.email,
          phone: lead.phone,
          firstName: lead.firstName,
          lastName: lead.lastName,
          anonymousId: lead.anonymousId ?? null
        }
      : undefined
  };

  const metaCustomData = {
    content_type: "product",
    content_ids: [offerData.sku],
    content_name: offerData.name,
    value: offerData.unitAmount / 100,
    payment_intent_id: paymentIntent.id
  };

  await finalizeAcceptedOffer({
    offerId: offer.id,
    orderId: order.id,
    funnelSessionId: order.funnelSessionId,
    paymentIntentId: paymentIntent.id,
    paymentMethodId: paymentIntent.payment_method,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    metaContext,
    metaCustomData
  });

  await firePurchaseIfTerminal(order.id);
}
