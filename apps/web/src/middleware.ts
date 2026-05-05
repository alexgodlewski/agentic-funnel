import { defineMiddleware } from "astro:middleware";

const ANONYMOUS_ID_COOKIE = "lts.anonymous_id";
// 365 days. Long enough that returning visitors keep the same PostHog identity
// across a multi-touch ad campaign without needing localStorage on every page.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function generateAnonymousId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback (Node 18 has globalThis.crypto, but be defensive)
  return `anon-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export const onRequest = defineMiddleware(async (context, next) => {
  let anonymousId = context.cookies.get(ANONYMOUS_ID_COOKIE)?.value;

  if (!anonymousId) {
    anonymousId = generateAnonymousId();
    context.cookies.set(ANONYMOUS_ID_COOKIE, anonymousId, {
      path: "/",
      maxAge: COOKIE_MAX_AGE,
      sameSite: "lax",
      // Use httpOnly:false so client JS can also read it (parity with the
      // existing localStorage usage during the migration to cookie-only).
      httpOnly: false,
      secure: import.meta.env.PROD
    });
  }

  context.locals.anonymousId = anonymousId;

  return next();
});
