import { metaEventId as sharedMetaEventId } from "@agentic-funnel/shared";

type MetaCustomData = Record<string, unknown>;

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

const STANDARD_EVENTS = new Set([
  "PageView",
  "Lead",
  "AddToCart",
  "InitiateCheckout",
  "AddPaymentInfo",
  "Purchase",
  "ViewContent"
]);

export function trackMeta(eventName: string, eventId: string, customData: MetaCustomData = {}) {
  if (typeof window === "undefined" || typeof window.fbq !== "function") {
    return;
  }
  const verb = STANDARD_EVENTS.has(eventName) ? "track" : "trackCustom";
  window.fbq(verb, eventName, customData, { eventID: eventId });
}

export function readFbCookies(): { fbp?: string; fbc?: string } {
  if (typeof document === "undefined") return {};
  const get = (name: string) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };
  return { fbp: get("_fbp"), fbc: get("_fbc") };
}

/**
 * Headers to attach to any client → server POST that ends up enqueueing a Meta
 * CAPI event. Mirrors `_fbp` / `_fbc` cookies as `x-meta-fbp` / `x-meta-fbc` so
 * the server still sees them when a reverse proxy strips cookies.
 */
export function metaForwardHeaders(): Record<string, string> {
  const { fbp, fbc } = readFbCookies();
  const headers: Record<string, string> = {};
  if (fbp) headers["x-meta-fbp"] = fbp;
  if (fbc) headers["x-meta-fbc"] = fbc;
  return headers;
}

// Re-export the shared event-id formatter so client call sites import from one
// place. Keeping a single canonical implementation prevents the format drifting
// between server and client.
export const metaEventId = sharedMetaEventId;

let pageviewFired = false;

if (typeof document !== "undefined") {
  // View Transitions / `<ClientRouter />` keep the same document across
  // navigations — the module-level `pageviewFired` flag would otherwise stick
  // and silently drop subsequent PageViews. `astro:page-load` fires after each
  // soft navigation; resetting here lets the next call to `firePageView` fire.
  document.addEventListener("astro:page-load", () => {
    pageviewFired = false;
  });
}

export function firePageView(scope: { distinctId?: string; anonymousId?: string }): string | null {
  if (typeof window === "undefined" || pageviewFired) return null;
  pageviewFired = true;
  const id = scope.distinctId ?? scope.anonymousId ?? "anon";
  const minute = Math.floor(Date.now() / 60_000);
  const eventId = metaEventId("pageview", `${id}:${window.location.pathname}:${minute}`);
  trackMeta("PageView", eventId);
  return eventId;
}
