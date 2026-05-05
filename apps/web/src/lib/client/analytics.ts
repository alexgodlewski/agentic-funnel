import { firePageView, readFbCookies } from "./meta-pixel";

const placeholderPattern = /(placeholder|changeme|replace|example|dummy|local_placeholder)/i;
type PostHogClient = typeof import("posthog-js").default;

let posthogClient: PostHogClient | null = null;
let posthogReady = false;

type AnalyticsOptions = {
  posthogKey: string;
  apiHost: string;
  metaPixelId: string;
  /**
   * Canonical PostHog distinct_id for this user. Sourced from the
   * `lts.anonymous_id` cookie set by Astro middleware so the same id is used
   * from first pageview through every server-side event.
   */
  anonymousId: string;
  /** Optional super-properties (auto-attached to every client event). */
  superProperties?: Record<string, unknown>;
};

function canUsePostHog(key: string) {
  return Boolean(key) && !placeholderPattern.test(key);
}

function canUseMetaPixel(id: string) {
  return Boolean(id) && !placeholderPattern.test(id);
}

export function initFunnelAnalytics(options: AnalyticsOptions) {
  if (typeof window === "undefined") {
    return;
  }

  if (canUsePostHog(options.posthogKey)) {
    void import("posthog-js").then(({ default: posthog }) => {
      posthogClient = posthog;
      posthog.init(options.posthogKey, {
        api_host: options.apiHost,
        ui_host: "https://us.posthog.com",
        capture_pageview: true,
        // We emit our own $pageleave from wireScrollTracking() with scroll
        // depth properties (max/last percentage + pixels + scrolled). Disabling
        // the auto-capture avoids two competing $pageleave events per page.
        capture_pageleave: false,
        persistence: "localStorage+cookie",
        person_profiles: "always",
        // Use the cookie-based anonymousId as the canonical distinct_id so
        // server and client events land on the same PostHog person.
        bootstrap: {
          distinctID: options.anonymousId
        },
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "[data-mask]"
        }
      });

      // Attach super-properties so every client event carries them
      // (funnel_key, funnel_session_id, etc.) without per-call wiring.
      if (options.superProperties) {
        posthog.register(options.superProperties);
      }

      posthogReady = true;

      // Bootstrap should already use this id, but call identify defensively
      // in case bootstrap was skipped (e.g., re-init).
      posthog.identify(options.anonymousId);
    });
  }

  if (canUseMetaPixel(options.metaPixelId)) {
    const eventId = firePageView({
      distinctId: options.anonymousId,
      anonymousId: options.anonymousId
    });
    if (eventId) {
      const { fbp, fbc } = readFbCookies();
      const beaconBody = JSON.stringify({
        eventId,
        path: window.location.pathname,
        distinctId: options.anonymousId,
        anonymousId: options.anonymousId,
        fbp,
        fbc
      });
      try {
        const blob = new Blob([beaconBody], { type: "application/json" });
        if (!navigator.sendBeacon || !navigator.sendBeacon("/api/meta/pageview", blob)) {
          void fetch("/api/meta/pageview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: beaconBody,
            keepalive: true
          }).catch(() => undefined);
        }
      } catch {
        // ignore beacon failure; pixel fired client-side anyway
      }
    }
  }
}

export function identifyAnalytics(distinctId: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") {
    return;
  }

  if (!posthogReady || !posthogClient) {
    return;
  }

  posthogClient.identify(distinctId, properties);
}

export function setUserProperties(
  set?: Record<string, unknown>,
  setOnce?: Record<string, unknown>
) {
  if (typeof window === "undefined") return;
  if (!posthogReady || !posthogClient) return;
  if (set) posthogClient.setPersonProperties(set, setOnce ?? undefined);
  else if (setOnce) posthogClient.setPersonProperties({}, setOnce);
}

export function captureAnalyticsEvent(event: string, properties: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  if (!posthogReady || !posthogClient) {
    return;
  }

  posthogClient.capture(event, properties);
}

export function wireScrollTracking(sectionSelector = "[data-section]") {
  if (typeof window === "undefined") {
    return;
  }

  const seenSections = new Set<string>();
  let maxPercentage = 0;
  let maxPixels = 0;
  let rafScheduled = false;
  let exitFired = false;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }

        const id = entry.target.getAttribute("data-section");
        if (id && !seenSections.has(id)) {
          seenSections.add(id);
          captureAnalyticsEvent("Section Seen", { section: id });
        }
      });
    },
    { threshold: 0.4 }
  );

  document.querySelectorAll(sectionSelector).forEach((node) => observer.observe(node));

  // Percentage as a 0–1 float (PostHog's tutorial convention) — keeps insights
  // simple ("avg of max_scroll_percentage" reads as 0.62 = 62%).
  const computeDepth = () => {
    const scrollTop = window.scrollY;
    const viewport = window.innerHeight;
    const height = document.documentElement.scrollHeight || 1;
    const pixels = scrollTop + viewport;
    const percentage = Math.min(1, pixels / height);
    return { pixels, percentage };
  };

  // rAF-throttle: a touch scroll on iOS fires the listener 100s of times per
  // second. Coalescing into the next frame keeps CPU minimal without missing
  // any visible state (max only updates between paints anyway).
  const onScroll = () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      const { pixels, percentage } = computeDepth();
      if (percentage > maxPercentage) maxPercentage = percentage;
      if (pixels > maxPixels) maxPixels = pixels;
    });
  };

  // Custom $pageleave with scroll depth properties. Auto $pageleave is
  // disabled in init() so this is the single canonical exit event per page.
  // Fired once (whichever signal comes first wins): pagehide for true
  // navigations/closes, visibilitychange:hidden for tab switches and iOS where
  // pagehide can be flaky.
  const fireExit = () => {
    if (exitFired) return;
    exitFired = true;
    const { pixels, percentage } = computeDepth();
    if (percentage > maxPercentage) maxPercentage = percentage;
    if (pixels > maxPixels) maxPixels = pixels;
    captureAnalyticsEvent("$pageleave", {
      max_scroll_percentage: maxPercentage,
      max_scroll_pixels: maxPixels,
      last_scroll_percentage: percentage,
      last_scroll_pixels: pixels,
      scrolled: maxPixels > 0
    });
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pagehide", fireExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      fireExit();
    }
  });
}

function writeAnonymousIdCookie(value: string) {
  if (typeof document === "undefined") return;
  // 365 days, Path=/, Lax. Mirrors the middleware's cookie shape so server-
  // rendered pages and middleware see the same id on the next navigation.
  const oneYear = 60 * 60 * 24 * 365;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `lts.anonymous_id=${encodeURIComponent(value)}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure}`;
}

/**
 * Read the canonical anonymous_id (set by Astro middleware as a cookie). Falls
 * back to localStorage during the cookie-rollout window for any user that
 * landed before the middleware shipped, then mirrors back to localStorage so
 * downstream code keeps working.
 */
export function readAnonymousId(): string {
  if (typeof window === "undefined") return "";
  try {
    const fromCookie = document.cookie
      .split("; ")
      .find((row) => row.startsWith("lts.anonymous_id="))
      ?.split("=")[1];
    if (fromCookie) {
      try {
        window.localStorage.setItem("lts.anonymous_id", fromCookie);
      } catch {
        // ignore (private mode)
      }
      return decodeURIComponent(fromCookie);
    }
    const fromLs = window.localStorage.getItem("lts.anonymous_id");
    if (fromLs) {
      // Mirror back to cookie so the next server-rendered page sees the same
      // id (Astro middleware would otherwise mint a fresh one).
      writeAnonymousIdCookie(fromLs);
      return fromLs;
    }
    const created = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `anon-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    window.localStorage.setItem("lts.anonymous_id", created);
    writeAnonymousIdCookie(created);
    return created;
  } catch {
    return "";
  }
}
