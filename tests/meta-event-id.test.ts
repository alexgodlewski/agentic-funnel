import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  hashMetaEmail,
  hashMetaName,
  hashMetaPhone,
  metaEventId,
  metaEventNames,
  normalizeMetaEmail,
  normalizeMetaName,
  normalizeMetaPhone,
  sha256Hex
} from "../packages/shared/src/meta";

const sha256Reference = (input: string) => createHash("sha256").update(input).digest("hex");

describe("metaEventId", () => {
  it("is deterministic for the same scope + key", () => {
    expect(metaEventId("purchase", "abc")).toBe(metaEventId("purchase", "abc"));
  });

  it("differs across scopes for the same key", () => {
    expect(metaEventId("purchase", "abc")).not.toBe(metaEventId("oto_accepted", "abc"));
  });

  it("uses the documented scope:key format", () => {
    expect(metaEventId("initiate_checkout", "uuid-1")).toBe("initiate_checkout:uuid-1");
  });
});

describe("sha256Hex", () => {
  it("matches Node crypto SHA-256 hex output", async () => {
    const input = "buyer@example.com";
    const fromWebCrypto = await sha256Hex(input);
    const fromNode = sha256Reference(input);
    expect(fromWebCrypto).toBe(fromNode);
    expect(fromWebCrypto).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(fromWebCrypto)).toBe(true);
  });

  it("produces different digests for different inputs", async () => {
    const a = await sha256Hex("a");
    const b = await sha256Hex("b");
    expect(a).not.toBe(b);
  });
});

describe("Meta PII hashers", () => {
  it("normalizes email before hashing", async () => {
    const dirty = "  Buyer@EXAMPLE.com ";
    const hashed = await hashMetaEmail(dirty);
    expect(hashed).toBe(sha256Reference(normalizeMetaEmail(dirty)));
    expect(normalizeMetaEmail(dirty)).toBe("buyer@example.com");
  });

  it("strips non-digits before hashing phone", async () => {
    const dirty = "+1 (555) 123-4567";
    const hashed = await hashMetaPhone(dirty);
    expect(hashed).toBe(sha256Reference(normalizeMetaPhone(dirty)));
    expect(normalizeMetaPhone(dirty)).toBe("15551234567");
  });

  it("lowercases names before hashing", async () => {
    const hashed = await hashMetaName("  Jordan  ");
    expect(hashed).toBe(sha256Reference(normalizeMetaName("  Jordan  ")));
    expect(normalizeMetaName("  Jordan  ")).toBe("jordan");
  });
});

describe("metaEventNames", () => {
  it("includes the full standard + custom event suite", () => {
    const expected = [
      "PageView",
      "Lead",
      "AddToCart",
      "InitiateCheckout",
      "AddPaymentInfo",
      "Purchase",
      "ViewContent",
      "OTO_Viewed",
      "OTO_Accepted",
      "OTO_Rejected",
      "Downsell_Viewed",
      "Downsell_Accepted",
      "Downsell_Rejected"
    ];
    for (const name of expected) {
      expect(metaEventNames).toContain(name);
    }
  });
});
