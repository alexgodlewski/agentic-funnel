import { describe, expect, it } from "vitest";

import { signOfferToken, verifyOfferToken } from "../packages/shared/src/crypto";

describe("offer token signing", () => {
  const secret = "12345678901234567890123456789012";

  it("round-trips a valid token", () => {
    const token = signOfferToken(
      {
        version: 1,
        orderId: "4d4c0780-e691-4847-89c9-5c497e055d74",
        funnelSessionId: "9c98fdb2-ebbb-44ad-9d43-e4648b638c99",
        offerInstanceId: "325bec08-b0b8-45fc-b766-0a67d43d3b2b",
        offerType: "oto",
        issuedAt: "2099-04-23T12:00:00.000Z",
        expiresAt: "2099-04-23T12:10:00.000Z"
      },
      secret
    );

    const payload = verifyOfferToken(token, secret);
    expect(payload.offerType).toBe("oto");
    expect(payload.orderId).toBe("4d4c0780-e691-4847-89c9-5c497e055d74");
  });

  it("rejects an invalid signature", () => {
    const token = signOfferToken(
      {
        version: 1,
        orderId: "4d4c0780-e691-4847-89c9-5c497e055d74",
        funnelSessionId: "9c98fdb2-ebbb-44ad-9d43-e4648b638c99",
        offerInstanceId: "325bec08-b0b8-45fc-b766-0a67d43d3b2b",
        offerType: "downsell",
        issuedAt: "2026-04-23T12:00:00.000Z",
        expiresAt: "2099-04-23T12:10:00.000Z"
      },
      secret
    );

    expect(() => verifyOfferToken(`${token}tampered`, secret)).toThrow("Invalid offer token signature");
  });
});
