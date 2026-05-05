import { createHmac, timingSafeEqual } from "node:crypto";

import { webEnv } from "../env";

/**
 * Token-based download links for purchased products.
 *
 * Generates a signed token (HMAC-SHA256 over JSON payload) embedding orderId,
 * sku, and expiry. Verified server-side before serving the file. No DB
 * lookup needed for the token itself — the signature proves authenticity and
 * the expiry timestamp prevents indefinite reuse.
 *
 * URL format: /api/downloads?token={base64url-payload}.{base64url-signature}
 *
 * Default TTL: 48h (typical for agentic-funnel digital products — long enough for
 * the buyer to download from work / different device, short enough to limit
 * casual sharing).
 */

export type DownloadTokenPayload = {
  orderId: string;
  sku: string;
  /** Index into line.metadata.assets[] when the slot delivers multiple files
   * (e.g., CORE = main ebook + 2 bonuses). Absent or 0 means "first asset" or
   * the legacy single-file paths (metadata.r2Key, asset_bundle_id). */
  assetIndex?: number;
  /** Unix epoch milliseconds */
  expiresAt: number;
  /** Random nonce so two tokens for same (order, sku) differ */
  nonce: string;
};

const DEFAULT_TTL_HOURS = 48;

export function signDownloadToken(
  input: { orderId: string; sku: string; assetIndex?: number; ttlHours?: number },
  secret: string = webEnv.APP_SIGNING_SECRET
): { token: string; url: string; expiresAt: number } {
  const ttl = (input.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttl;
  const nonce = Math.random().toString(36).slice(2, 10);

  const payload: DownloadTokenPayload = {
    orderId: input.orderId,
    sku: input.sku,
    expiresAt,
    nonce,
    ...(typeof input.assetIndex === "number" ? { assetIndex: input.assetIndex } : {})
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  const token = `${encodedPayload}.${signature}`;

  return {
    token,
    url: `/api/downloads?token=${token}`,
    expiresAt
  };
}

export function verifyDownloadToken(
  token: string,
  secret: string = webEnv.APP_SIGNING_SECRET
): DownloadTokenPayload {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    throw new Error("Malformed download token");
  }

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");

  if (signature.length !== expectedSignature.length) {
    throw new Error("Invalid download token signature");
  }
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new Error("Invalid download token signature");
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as DownloadTokenPayload;

  if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) {
    throw new Error("Download token expired");
  }

  if (typeof payload.orderId !== "string" || typeof payload.sku !== "string") {
    throw new Error("Download token payload invalid");
  }

  return payload;
}
