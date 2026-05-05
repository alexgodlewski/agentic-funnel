import { eq, inArray } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";

import { buildSignedAssetUrl } from "../lib/assets";
import { db } from "../lib/db";
import { renderFulfillmentEmail } from "../lib/email-templates/fulfillment-links";

export async function queueFulfillmentEmail(payload: { orderId: string }) {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, payload.orderId))
    .limit(1);

  if (!order) {
    throw new Error("Order not found for fulfillment");
  }

  const [funnelSession] = await db
    .select()
    .from(schema.funnelSessions)
    .where(eq(schema.funnelSessions.id, order.funnelSessionId))
    .limit(1);

  const [lead] = funnelSession
    ? await db.select().from(schema.leads).where(eq(schema.leads.id, funnelSession.leadId)).limit(1)
    : [];

  if (!lead) {
    throw new Error("Lead not found for fulfillment");
  }

  const lines = await db
    .select()
    .from(schema.orderLines)
    .where(eq(schema.orderLines.orderId, order.id));

  // New path: order_line.metadata.r2Key (set by buildCheckoutQuote from Stripe
  // Product metadata.r2_key). Legacy path: assetBundleId FK → asset_bundle row.
  // Lines written before the Stripe-driven catalog refactor still resolve via
  // the legacy path; new lines never set assetBundleId.
  const legacyBundleIds = lines
    .map((line) => line.assetBundleId)
    .filter((value): value is string => Boolean(value));
  const legacyBundles = legacyBundleIds.length
    ? await db
        .select()
        .from(schema.assetBundles)
        .where(inArray(schema.assetBundles.id, legacyBundleIds))
    : [];
  const legacyBundleMap = new Map(legacyBundles.map((bundle) => [bundle.id, bundle]));

  // Three delivery paths in priority order:
  //  1. metadata.assets — multi-file slot (e.g., CORE = main + 2 bonuses).
  //     Sign each r2Key, emit one button per entry.
  //  2. metadata.r2Key — single-file slot (from Stripe Product metadata).
  //  3. assetBundleId FK — legacy asset_bundle row. Only used by lines
  //     written before the Stripe-driven catalog refactor.
  const assetBatches = await Promise.all(
    lines.map(async (line): Promise<Array<{ label: string; url: string }>> => {
      const meta = (line.metadata ?? {}) as Record<string, unknown>;

      const slotAssets = Array.isArray(meta.assets)
        ? (meta.assets as Array<{ label?: unknown; r2Key?: unknown }>)
            .filter((a) => typeof a?.label === "string" && typeof a?.r2Key === "string")
            .map((a) => ({ label: a.label as string, r2Key: a.r2Key as string }))
        : [];
      if (slotAssets.length > 0) {
        return Promise.all(
          slotAssets.map(async (a) => ({
            label: a.label,
            url: await buildSignedAssetUrl(a.r2Key)
          }))
        );
      }

      if (typeof meta.r2Key === "string") {
        return [{ label: line.name, url: await buildSignedAssetUrl(meta.r2Key) }];
      }

      if (line.assetBundleId) {
        const bundle = legacyBundleMap.get(line.assetBundleId);
        if (bundle) {
          return [
            {
              label: line.name,
              url: await buildSignedAssetUrl(bundle.storageKey, bundle.storageBucket)
            }
          ];
        }
      }

      return [];
    })
  );

  const filteredAssets = assetBatches.flat();

  const { subject, html, text } = renderFulfillmentEmail({
    firstName: lead.firstName ?? "",
    orderId: order.id,
    assets: filteredAssets
  });

  await db
    .insert(schema.outboxEvents)
    .values({
      aggregateType: "order",
      aggregateId: order.id,
      channel: "mailgun",
      eventName: "mail.send",
      dedupeKey: `mailgun:fulfillment:${order.id}`,
      payload: {
        to: lead.email,
        subject,
        html,
        text,
        tags: ["fulfillment", "order"]
      }
    })
    .onConflictDoNothing({ target: schema.outboxEvents.dedupeKey });
}
