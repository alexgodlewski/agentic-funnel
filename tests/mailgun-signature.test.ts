import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyMailgunSignature } from "../packages/shared/src/crypto";

describe("verifyMailgunSignature", () => {
  it("accepts a valid signature", () => {
    const signingKey = "mailgun-secret";
    const timestamp = "1713873600";
    const token = "random-token";
    const signature = createHmac("sha256", signingKey).update(`${timestamp}${token}`).digest("hex");

    expect(
      verifyMailgunSignature({
        signingKey,
        timestamp,
        token,
        signature
      })
    ).toBe(true);
  });

  it("rejects an invalid signature", () => {
    expect(
      verifyMailgunSignature({
        signingKey: "mailgun-secret",
        timestamp: "1713873600",
        token: "random-token",
        signature: "00"
      })
    ).toBe(false);
  });
});
