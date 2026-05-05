import { checkoutQuoteSchema, type CheckoutQuote } from "@agentic-funnel/shared";

import { stripeSlots, type StripeSlot } from "./funnels.generated";

/**
 * Stripe is the source of truth for: name, price, currency, r2 download key
 * (all resolved at build time → funnels.generated.ts).
 *
 * This file merges those values with hardcoded display copy (badges, bullets,
 * images, descriptions). Slot is missing from Stripe → product is hidden.
 */

/**
 * Multi-file download asset for a single slot. When set, the fulfillment
 * email signs each `r2Key` (7-day TTL) and renders one button per entry.
 * Used when a slot delivers multiple files (e.g., CORE = main ebook + 2
 * bonuses) where Stripe's single-`r2_key` Product metadata isn't enough.
 */
export type SlotAsset = {
  label: string;
  r2Key: string;
};

type CatalogOffer = {
  /** Stable internal SKU. Drives idempotency, dedupe, analytics. */
  sku: string;
  /** Slot key for matching to STRIPE_PRICE_* env / Stripe Price. */
  slot: StripeSlot;
  /** Product name (from Stripe). */
  name: string;
  /** Minor units (from Stripe price.unit_amount). */
  unitAmount: number;
  /** R2 object key for the download (from Stripe Product metadata.r2_key). */
  r2Key: string | null;
  /** Multi-file override (each signed at fulfillment time). Wins over r2Key. */
  assets?: SlotAsset[];
};

export type BumpDisplay = CatalogOffer & {
  /** Strikethrough anchor price in minor units. Optional. */
  crossedAmount?: number;
  /** Short tagline shown above the price (e.g. "One-time offer"). */
  badge?: string;
  /** Short pitch line shown next to the title. */
  tagline?: string;
  /** Full-paragraph description shown in the bump card body. */
  description: string;
  /** Bullet points listed below the description. */
  bullets?: string[];
  /** Closing scarcity / disclaimer line. */
  closer?: string;
  /** Optional hero image (book cover) shown on the left of the card. */
  image?: string;
};

type FunnelDefinition = {
  key: string;
  currency: string;
  /** Always present — checkout would not exist without it. */
  core: CatalogOffer;
  /** Display-rich list of order bumps. May be empty if no bump slots configured. */
  orderBumps: BumpDisplay[];
  /** OTO upsell. `null` if STRIPE_PRICE_OTO is unset. */
  oto: CatalogOffer | null;
  /** Downsell. `null` if STRIPE_PRICE_DOWNSELL is unset. */
  downsell: CatalogOffer | null;
};

/**
 * Hardcoded display copy keyed by funnel + slot. Stripe owns name + price;
 * this file owns everything else marketing-y. To update copy: edit here.
 * To update price/name/download: edit Stripe → re-run `pnpm sync:stripe`.
 */
type SlotCopy = {
  sku: string;
  /** Bump-only enrichment. */
  bump?: Omit<BumpDisplay, keyof CatalogOffer>;
  /** Multi-file delivery (overrides single-file r2Key from Stripe metadata). */
  assets?: SlotAsset[];
};

// Slots omitted from this map are disabled for the funnel — `getFunnelDefinition`
// returns `null` for them, and downstream code (offer-service, downsell page)
// already handles a missing slot gracefully (skips straight to thank-you).
const STARTER_FUNNEL_COPY: Partial<Record<StripeSlot, SlotCopy>> = {
  CORE: {
    sku: "starter-playbook",
    assets: [
      {
        label: "Starter Playbook",
        r2Key: "starter-funnel/core/starter-playbook.pdf"
      },
      {
        label: "Implementation Checklist",
        r2Key: "starter-funnel/core/implementation-checklist.pdf"
      },
      {
        label: "Launch Swipe File",
        r2Key: "starter-funnel/core/launch-swipe-file.pdf"
      }
    ]
  },
  ORDER_BUMP_1: {
    sku: "templates-pack",
    assets: [
      {
        label: "Checkout Templates Pack",
        r2Key: "starter-funnel/order-bump-1/checkout-templates.zip"
      }
    ],
    bump: {
      badge: "One-time add-on",
      tagline: "Add the templates pack",
      description:
        "A lightweight pack of checkout, offer, and email templates your buyers can use immediately after purchase.",
      bullets: [
        "Checkout copy blocks",
        "Order bump prompts",
        "Thank-you page checklist",
        "Fulfillment email examples"
      ],
      closer:
        "Select this add-on to include the templates in the same order and fulfillment email.",
      image: "/starter-bump-1.png"
    }
  },
  ORDER_BUMP_2: {
    sku: "audio-companion",
    assets: [
      {
        label: "Audio Companion",
        r2Key: "starter-funnel/order-bump-2/audio-companion.zip"
      }
    ],
    bump: {
      crossedAmount: 4900,
      badge: "Popular upgrade",
      tagline: "Add the audio companion",
      description:
        "A short audio version of the core material for buyers who want to review the offer while commuting, walking, or working.",
      bullets: ["Portable lesson files", "Quick recap track", "Buyer action prompts"],
      closer: "This is a starter example. Replace it with the upgrade that makes sense for your product.",
      image: "/starter-bump-2.png"
    }
  },
  OTO: {
    sku: "implementation-workshop",
    assets: [
      {
        label: "Implementation Workshop",
        r2Key: "starter-funnel/oto/implementation-workshop.zip"
      }
    ]
  },
  DOWNSELL: {
    sku: "quickstart-mini",
    assets: [
      {
        label: "Quickstart Mini Course",
        r2Key: "starter-funnel/downsell/quickstart-mini.zip"
      }
    ]
  }
};

type FunnelCopy = {
  key: string;
  /** Default currency, used only if no slots resolved (empty catalog edge case). */
  fallbackCurrency: string;
  copy: Partial<Record<StripeSlot, SlotCopy>>;
};

const FUNNEL_COPY: Record<string, FunnelCopy> = {
  "starter-funnel": {
    key: "starter-funnel",
    fallbackCurrency: "usd",
    copy: STARTER_FUNNEL_COPY
  }
};

function buildOffer(slot: StripeSlot, copy: SlotCopy | undefined): CatalogOffer | null {
  if (!copy) return null;
  const stripe = stripeSlots[slot];
  if (!stripe) return null;
  return {
    sku: copy.sku,
    slot,
    name: stripe.name,
    unitAmount: stripe.unitAmount,
    r2Key: stripe.r2Key,
    ...(copy.assets && copy.assets.length > 0 ? { assets: copy.assets } : {})
  };
}

function buildBump(slot: StripeSlot, copy: SlotCopy | undefined): BumpDisplay | null {
  const offer = buildOffer(slot, copy);
  if (!offer || !copy?.bump) return null;
  return {
    ...offer,
    ...copy.bump
  };
}

function buildFunnel(funnelCopy: FunnelCopy): FunnelDefinition | null {
  const core = buildOffer("CORE", funnelCopy.copy.CORE);
  if (!core) return null;

  const orderBumps = (["ORDER_BUMP_1", "ORDER_BUMP_2"] as const)
    .map((slot) => buildBump(slot, funnelCopy.copy[slot]))
    .filter((bump): bump is BumpDisplay => bump !== null);

  // Currency comes from whichever slot is present; CORE wins, fall back to first
  // available, then to the funnel's fallbackCurrency for type safety.
  const currency =
    stripeSlots.CORE?.currency ??
    stripeSlots.ORDER_BUMP_1?.currency ??
    stripeSlots.ORDER_BUMP_2?.currency ??
    funnelCopy.fallbackCurrency;

  return {
    key: funnelCopy.key,
    currency,
    core,
    orderBumps,
    oto: buildOffer("OTO", funnelCopy.copy.OTO),
    downsell: buildOffer("DOWNSELL", funnelCopy.copy.DOWNSELL)
  };
}

function buildCatalog(): Record<string, FunnelDefinition> {
  const out: Record<string, FunnelDefinition> = {};
  for (const [key, copy] of Object.entries(FUNNEL_COPY)) {
    const built = buildFunnel(copy);
    if (built) out[key] = built;
  }
  return out;
}

export const funnelCatalog: Record<string, FunnelDefinition> = buildCatalog();

export function getFunnelDefinition(funnelKey: string) {
  const definition = funnelCatalog[funnelKey];

  if (!definition) {
    throw new Error(
      `Unknown or unconfigured funnel key: ${funnelKey}. ` +
        `Set STRIPE_PRICE_CORE and re-run \`pnpm sync:stripe\`.`
    );
  }

  return definition;
}

function offerToQuoteItemMetadata(offer: CatalogOffer) {
  // `assets` wins — when present the fulfillment job signs each entry's
  // r2Key and renders one button per asset. Otherwise fall back to the
  // single-file r2Key (from Stripe Product metadata). Safe to coexist.
  const meta: Record<string, unknown> = {};
  if (offer.assets && offer.assets.length > 0) {
    meta.assets = offer.assets;
  }
  if (offer.r2Key) {
    meta.r2Key = offer.r2Key;
  }
  return meta;
}

export type ResolvedDiscount = {
  promoCode: string;
  /** Hard-scoped to CORE for now; the Stripe coupon enforces this server-side. */
  appliesToKind: "core";
  percentOff: number;
};

export function buildCheckoutQuote(
  funnelKey: string,
  selectedBumpSkus: readonly string[] = [],
  discount?: ResolvedDiscount | null
): CheckoutQuote {
  const funnel = getFunnelDefinition(funnelKey);
  const items: CheckoutQuote["items"] = [
    {
      kind: "core" as const,
      sku: funnel.core.sku,
      name: funnel.core.name,
      quantity: 1,
      unitAmount: funnel.core.unitAmount,
      totalAmount: funnel.core.unitAmount,
      metadata: offerToQuoteItemMetadata(funnel.core)
    }
  ];

  // Iterate the catalog (not the input) so totals are deterministic regardless
  // of the order the UI sends the SKUs in. Unknown SKUs are ignored.
  for (const bump of funnel.orderBumps) {
    if (selectedBumpSkus.includes(bump.sku)) {
      items.push({
        kind: "order_bump" as const,
        sku: bump.sku,
        name: bump.name,
        quantity: 1,
        unitAmount: bump.unitAmount,
        totalAmount: bump.unitAmount,
        metadata: offerToQuoteItemMetadata(bump)
      });
    }
  }

  const subtotalAmount = items.reduce((sum, item) => sum + item.totalAmount, 0);
  const orderBumpSelected = items.some((item) => item.kind === "order_bump");

  // Apply discount to the matching line. Round the discount amount to integer
  // minor units (Stripe stores all money in integer minor units).
  let appliedDiscount: CheckoutQuote["discount"] = null;
  let discountAmount = 0;
  if (discount && discount.percentOff > 0) {
    const target = items.find((item) => item.kind === discount.appliesToKind);
    if (target) {
      discountAmount = Math.round((target.totalAmount * discount.percentOff) / 100);
      appliedDiscount = {
        promoCode: discount.promoCode,
        appliesToSku: target.sku,
        percentOff: discount.percentOff,
        amount: discountAmount
      };
    }
  }

  const totalAmount = Math.max(0, subtotalAmount - discountAmount);

  // offerSnapshot is required by the schema; emit zero-value placeholders when
  // an offer slot isn't configured so downstream consumers stay happy.
  const offerSnapshot = {
    oto: funnel.oto
      ? { sku: funnel.oto.sku, name: funnel.oto.name, unitAmount: funnel.oto.unitAmount }
      : { sku: "", name: "", unitAmount: 0 },
    downsell: funnel.downsell
      ? {
          sku: funnel.downsell.sku,
          name: funnel.downsell.name,
          unitAmount: funnel.downsell.unitAmount
        }
      : { sku: "", name: "", unitAmount: 0 }
  };

  return checkoutQuoteSchema.parse({
    funnelKey: funnel.key,
    currency: funnel.currency,
    subtotalAmount,
    totalAmount,
    items,
    orderBumpSelected,
    discount: appliedDiscount,
    offerSnapshot
  });
}

export function getOfferFromFunnel(
  funnelKey: string,
  offerType: "oto" | "downsell"
): CatalogOffer | null {
  const funnel = getFunnelDefinition(funnelKey);
  return funnel[offerType];
}
