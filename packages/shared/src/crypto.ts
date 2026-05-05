import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { offerTokenPayloadSchema, type OfferTokenPayload } from "./schemas";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeCompareHex(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function signOfferToken(payload: OfferTokenPayload, secret: string) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export function verifyOfferToken(token: string, secret: string) {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    throw new Error("Malformed offer token");
  }

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");

  if (signature.length !== expectedSignature.length) {
    throw new Error("Invalid offer token signature");
  }

  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new Error("Invalid offer token signature");
  }

  const payload = offerTokenPayloadSchema.parse(JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")));

  if (new Date(payload.expiresAt) <= new Date()) {
    throw new Error("Offer token expired");
  }

  return payload;
}

export function verifyMailgunSignature(input: {
  signingKey: string;
  timestamp: string;
  token: string;
  signature: string;
}) {
  const computed = createHmac("sha256", input.signingKey)
    .update(`${input.timestamp}${input.token}`)
    .digest("hex");

  return safeCompareHex(computed, input.signature);
}
