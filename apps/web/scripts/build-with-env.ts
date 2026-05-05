/**
 * Wraps `astro build` so STRIPE_TEST_ and STRIPE_LIVE_ vars are projected onto
 * canonical names BEFORE Vite inlines them into the client bundle. Without
 * this wrapper, Vite reads only `process.env.PUBLIC_STRIPE_PUBLISHABLE_KEY`
 * (and other canonical vars) — our env.ts resolver runs at server runtime
 * and never affects what Vite bakes into the static JS. Result without the
 * wrapper: a STRIPE_MODE=live deploy can ship a pk_test publishable key in
 * the browser bundle and PaymentIntents 400 with a key/intent mode mismatch.
 */
import { spawnSync } from "node:child_process";

import { getStripeMode, resolveStripeEnv } from "../src/lib/server/stripe-env";

const mode = getStripeMode(process.env);
const projected = resolveStripeEnv(process.env);
console.log(`[build-with-env] STRIPE_MODE=${mode}; projecting ${Object.keys(projected).length} canonical Stripe vars onto build env.`);

const result = spawnSync("astro", ["build"], {
  stdio: "inherit",
  env: { ...process.env, ...projected }
});
process.exit(result.status ?? 1);
