import { describe, expect, it } from "vitest";

import { buildCheckoutQuote, funnelCatalog } from "../apps/web/src/lib/config/funnels";

describe("buildCheckoutQuote", () => {
  const core = funnelCatalog["starter-funnel"]!.core.unitAmount;
  const [bumpA, bumpB] = funnelCatalog["starter-funnel"]!.orderBumps;

  it("returns the core item when no bumps are selected", () => {
    const quote = buildCheckoutQuote("starter-funnel", []);
    expect(quote.totalAmount).toBe(core);
    expect(quote.items).toHaveLength(1);
    expect(quote.items[0]?.kind).toBe("core");
    expect(quote.orderBumpSelected).toBe(false);
  });

  it("adds a single bump when one is selected", () => {
    const quote = buildCheckoutQuote("starter-funnel", [bumpA!.sku]);
    expect(quote.totalAmount).toBe(core + bumpA!.unitAmount);
    expect(quote.items).toHaveLength(2);
    expect(quote.items[1]?.sku).toBe(bumpA!.sku);
    expect(quote.orderBumpSelected).toBe(true);
  });

  it("adds both bumps in catalog order regardless of input order", () => {
    const quote = buildCheckoutQuote("starter-funnel", [bumpB!.sku, bumpA!.sku]);
    expect(quote.totalAmount).toBe(core + bumpA!.unitAmount + bumpB!.unitAmount);
    expect(quote.items.map((i) => i.sku)).toEqual([
      funnelCatalog["starter-funnel"]!.core.sku,
      bumpA!.sku,
      bumpB!.sku
    ]);
  });
});
