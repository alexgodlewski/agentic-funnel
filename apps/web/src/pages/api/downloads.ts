import type { APIRoute } from "astro";
import { sql } from "drizzle-orm";

import { schema } from "@agentic-funnel/db";
import { db } from "../../lib/server/db";
import { buildSignedAssetUrl, hasAssetStorage } from "../../lib/server/assets";
import { verifyDownloadToken } from "../../lib/server/services/download-token";

/**
 * GET /api/downloads?token={signed-token}
 *
 * Token-gated file delivery. The token (HMAC-SHA256 over payload) embeds:
 *   - orderId: the order this download belongs to
 *   - sku: which line item to download
 *   - expiresAt: epoch ms after which the link stops working (default 48h)
 *
 * Verification flow:
 *   1. Decode + verify HMAC signature (rejects tampered tokens)
 *   2. Check expiry (rejects stale tokens)
 *   3. Atomically increment + check the per-(order, sku) download counter
 *      — limited to MAX_DOWNLOADS_PER_ITEM. The UPDATE only matches when the
 *      counter is below the cap, so a no-rows result means the limit is hit.
 *   4. Look up the asset bundle (storage_bucket + storage_key) and either:
 *        - Redirect to a signed S3 URL (production)
 *        - Serve a placeholder fallback (current dev / no S3 configured)
 */

const MAX_DOWNLOADS_PER_ITEM = 5;

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get("token") ?? "";

  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  let payload;
  try {
    payload = verifyDownloadToken(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid token";
    const status = msg.includes("expired") ? 410 : 403;
    return new Response(msg, { status });
  }

  // Atomic compare-and-increment on order_line.metadata.downloads.
  // Postgres jsonb_set + COALESCE handles both:
  //   - first download (no `downloads` key yet → starts at 0)
  //   - existing key (increments)
  // The WHERE clause filters BOTH by orderId+sku AND counter < cap, so:
  //   - No row matches → either order/sku missing OR limit hit
  //   - Row matches → increments AND returns new count + asset linkage
  const incremented = await db.execute<{
    line_id: string;
    sku: string;
    name: string;
    asset_bundle_id: string | null;
    new_count: number;
  }>(sql`
    UPDATE order_line
    SET metadata = jsonb_set(
          metadata,
          '{downloads}',
          to_jsonb(COALESCE((metadata->>'downloads')::int, 0) + 1)
        ),
        updated_at = NOW()
    WHERE order_id = ${payload.orderId}::uuid
      AND sku = ${payload.sku}
      AND COALESCE((metadata->>'downloads')::int, 0) < ${MAX_DOWNLOADS_PER_ITEM}
    RETURNING
      id AS line_id,
      sku,
      name,
      asset_bundle_id,
      (metadata->>'downloads')::int AS new_count
  `);

  const row = incremented.rows?.[0];
  if (!row) {
    // Either the (order, sku) pair doesn't exist OR the limit is hit. Distinguish.
    const exists = await db
      .select({ downloads: sql<number>`COALESCE((metadata->>'downloads')::int, 0)` })
      .from(schema.orderLines)
      .where(
        sql`${schema.orderLines.orderId} = ${payload.orderId}::uuid AND ${schema.orderLines.sku} = ${payload.sku}`
      )
      .limit(1);

    if (exists.length === 0) {
      return new Response("File no longer available for this order", { status: 404 });
    }
    return new Response(
      `Limit pobrań osiągnięty (${MAX_DOWNLOADS_PER_ITEM}). Skontaktuj się z nami jeśli potrzebujesz dodatkowego dostępu.`,
      { status: 429 }
    );
  }

  // Resolve the storage key in priority order:
  //   1. metadata.assets[assetIndex].r2Key — multi-file slots (CORE = 3 PDFs).
  //      Uses the token's assetIndex (default 0) to pick the right entry.
  //   2. metadata.r2Key — single-file slot (legacy / Stripe-driven catalog).
  //   3. asset_bundle_id FK — legacy asset_bundle row, signed via its bucket.
  //   4. placeholder text fallback (dev / no storage configured).
  //
  // The atomic increment above already returned the line's metadata via
  // RETURNING, but we re-select here because jsonb_set strips structure we
  // need (assets array). Cheap — one indexed lookup by primary key.
  const [line] = await db
    .select({ metadata: schema.orderLines.metadata })
    .from(schema.orderLines)
    .where(sql`${schema.orderLines.id} = ${row.line_id}::uuid`)
    .limit(1);
  const meta = (line?.metadata ?? {}) as Record<string, unknown>;

  let storageKey: string | null = null;
  let storageBucket: string | undefined = undefined;

  const assets = Array.isArray(meta.assets)
    ? (meta.assets as Array<{ r2Key?: unknown }>)
    : [];
  const assetIndex = typeof payload.assetIndex === "number" ? payload.assetIndex : 0;
  const indexedAsset = assets[assetIndex];
  if (indexedAsset && typeof indexedAsset.r2Key === "string") {
    storageKey = indexedAsset.r2Key;
  } else if (typeof meta.r2Key === "string") {
    storageKey = meta.r2Key;
  } else if (row.asset_bundle_id) {
    const [assetRow] = await db
      .select()
      .from(schema.assetBundles)
      .where(sql`${schema.assetBundles.id} = ${row.asset_bundle_id}::uuid`)
      .limit(1);
    if (assetRow && assetRow.active) {
      storageKey = assetRow.storageKey;
      storageBucket = assetRow.storageBucket;
    }
  }

  if (storageKey && hasAssetStorage()) {
    const signedUrl = await buildSignedAssetUrl(storageKey, storageBucket);
    return Response.redirect(signedUrl, 302);
  }

  return placeholderResponse(row.sku, row.name);
};

function placeholderResponse(sku: string, name: string) {
  const safeName = name.replace(/[^a-zA-Z0-9 -]/g, "").trim() || sku;
  const filename = `${safeName.replace(/\s+/g, "-").toLowerCase()}.txt`;
  const body =
    `${name}\n` +
    `\n` +
    `This is a placeholder file. In production, this URL redirects to a\n` +
    `signed download for the actual asset uploaded to object storage.\n`;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store"
    }
  });
}
