/* eslint-disable */
// Starter catalog for local development. DO NOT edit prices here for production.
// Stripe is the production source of truth; run `pnpm sync:stripe` after setting
// STRIPE_TEST_PRICE_* or STRIPE_LIVE_PRICE_* env vars.

export type StripeSlot = "CORE" | "ORDER_BUMP_1" | "ORDER_BUMP_2" | "OTO" | "DOWNSELL";

export type GeneratedSlot = {
  priceId: string;
  productId: string;
  name: string;
  currency: string;
  unitAmount: number;
  r2Key: string | null;
};

export const stripeSlots: Partial<Record<StripeSlot, GeneratedSlot>> = {
  CORE: {
    priceId: "price_replace_core",
    productId: "prod_replace_core",
    name: "Starter Playbook",
    currency: "usd",
    unitAmount: 2900,
    r2Key: "starter-funnel/core/starter-playbook.pdf"
  },
  ORDER_BUMP_1: {
    priceId: "price_replace_templates",
    productId: "prod_replace_templates",
    name: "Checkout Templates Pack",
    currency: "usd",
    unitAmount: 1900,
    r2Key: "starter-funnel/order-bump-1/checkout-templates.zip"
  },
  ORDER_BUMP_2: {
    priceId: "price_replace_audio",
    productId: "prod_replace_audio",
    name: "Audio Companion",
    currency: "usd",
    unitAmount: 900,
    r2Key: "starter-funnel/order-bump-2/audio-companion.zip"
  },
  OTO: {
    priceId: "price_replace_workshop",
    productId: "prod_replace_workshop",
    name: "Implementation Workshop",
    currency: "usd",
    unitAmount: 7900,
    r2Key: "starter-funnel/oto/implementation-workshop.zip"
  },
  DOWNSELL: {
    priceId: "price_replace_quickstart",
    productId: "prod_replace_quickstart",
    name: "Quickstart Mini Course",
    currency: "usd",
    unitAmount: 3900,
    r2Key: "starter-funnel/downsell/quickstart-mini.zip"
  }
};
