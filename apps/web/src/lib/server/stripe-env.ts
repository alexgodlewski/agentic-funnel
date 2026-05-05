/**
 * Picks STRIPE_TEST_* or STRIPE_LIVE_* values based on STRIPE_MODE and projects
 * them onto the canonical names the rest of the codebase reads (STRIPE_SECRET_KEY,
 * PUBLIC_STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_*).
 *
 * Used by env.ts (web runtime) and sync-stripe-products.ts (build-time sync).
 * Flip modes by setting STRIPE_MODE=live (default: test).
 */
export type StripeMode = "test" | "live";

export function getStripeMode(env: NodeJS.ProcessEnv = process.env): StripeMode {
  const raw = (env.STRIPE_MODE ?? "test").toLowerCase();
  return raw === "live" || raw === "prod" || raw === "production" ? "live" : "test";
}

const STRIPE_KEYS = [
  ["SECRET_KEY", "STRIPE_SECRET_KEY"],
  ["PUBLISHABLE_KEY", "PUBLIC_STRIPE_PUBLISHABLE_KEY"],
  ["WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET"],
  ["PRICE_CORE", "STRIPE_PRICE_CORE"],
  ["PRICE_ORDER_BUMP_1", "STRIPE_PRICE_ORDER_BUMP_1"],
  ["PRICE_ORDER_BUMP_2", "STRIPE_PRICE_ORDER_BUMP_2"],
  ["PRICE_OTO", "STRIPE_PRICE_OTO"],
  ["PRICE_DOWNSELL", "STRIPE_PRICE_DOWNSELL"]
] as const;

export function resolveStripeEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const mode = getStripeMode(env);
  const prefix = mode === "live" ? "STRIPE_LIVE_" : "STRIPE_TEST_";
  const out: Record<string, string | undefined> = {};
  for (const [suffix, canonical] of STRIPE_KEYS) {
    // Prefer the mode-prefixed value; fall back to the legacy canonical name
    // so services that haven't migrated to STRIPE_TEST_*/STRIPE_LIVE_* (e.g.
    // the worker on Railway) keep working with their existing env.
    const v = env[prefix + suffix] || env[canonical];
    if (v !== undefined && v !== "") out[canonical] = v;
  }
  return out;
}
