import { describe, expect, it } from "vitest";

import { metaEventId } from "../packages/shared/src/meta";

describe("Purchase event idempotency", () => {
  it("derives a stable eventId from orderId alone", () => {
    const orderId = "11111111-1111-1111-1111-111111111111";
    const ids = Array.from({ length: 5 }, () => metaEventId("purchase", orderId));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(`purchase:${orderId}`);
  });

  it("derives a different eventId for different orders", () => {
    const a = metaEventId("purchase", "11111111-1111-1111-1111-111111111111");
    const b = metaEventId("purchase", "22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
  });

  it("uses the dedupe-key prefix that prevents double-fire under outbox unique index", () => {
    const orderId = "33333333-3333-3333-3333-333333333333";
    const eventId = metaEventId("purchase", orderId);
    const dedupeKey = `meta:${eventId}`;
    expect(dedupeKey).toBe(`meta:purchase:${orderId}`);
  });
});

describe("Offer event idempotency", () => {
  it("uses the offer instance id as the stable key for view/accept/reject", () => {
    const offerId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    expect(metaEventId("oto_viewed", offerId)).toBe(`oto_viewed:${offerId}`);
    expect(metaEventId("oto_accepted", offerId)).toBe(`oto_accepted:${offerId}`);
    expect(metaEventId("oto_rejected", offerId)).toBe(`oto_rejected:${offerId}`);
    expect(metaEventId("downsell_accepted", offerId)).not.toBe(metaEventId("oto_accepted", offerId));
  });
});
