import { randomUUID } from "node:crypto";

import { webEnv } from "../env";

const placeholderPattern = /(placeholder|changeme|replace|example|dummy|local_placeholder)/i;

export function isPlaceholderSecret(value: string) {
  return placeholderPattern.test(value);
}

export function isStripeConfigured() {
  return !isPlaceholderSecret(webEnv.STRIPE_SECRET_KEY) && !isPlaceholderSecret(webEnv.PUBLIC_STRIPE_PUBLISHABLE_KEY);
}

export function isDemoProviderId(value?: string | null) {
  return value?.startsWith("demo_") ?? false;
}

export function createDemoProviderId(prefix: string) {
  return `demo_${prefix}_${randomUUID().replace(/-/g, "")}`;
}
