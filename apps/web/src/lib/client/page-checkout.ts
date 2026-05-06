import {
  captureAnalyticsEvent,
  identifyAnalytics,
  initFunnelAnalytics,
  readAnonymousId,
  setUserProperties,
  wireScrollTracking
} from "./analytics";
import { metaEventId, metaForwardHeaders, readFbCookies, trackMeta } from "./meta-pixel";

type CheckoutDiscount = {
  promoCode: string;
  appliesToSku: string;
  percentOff: number;
  amount: number;
};

type CheckoutIntentResponse = {
  checkoutAttemptId: string;
  paymentIntentId: string;
  clientSecret: string;
  quote: {
    totalAmount: number;
    currency: string;
    orderBumpSelected: boolean;
    items: { sku: string; unitAmount: number; kind: string }[];
    discount?: CheckoutDiscount | null;
  };
  metaEventIds?: { initiateCheckout?: string };
};

type LeadCaptureResponse = {
  leadId: string;
  funnelSessionId: string;
  metaEventIds?: { lead?: string };
};

type CheckoutStatusResponse = {
  status: string;
  nextUrl?: string;
  orderId?: string;
};

type StripeElementInstance = {
  mount: (selector: string) => void;
  destroy?: () => void;
  on?: (event: string, handler: (event: Record<string, unknown>) => void) => void;
};

type StripeWindow = Window & {
  Stripe?: (key: string) => {
    elements: (options: Record<string, unknown>) => {
      create: (type: string, options?: Record<string, unknown>) => StripeElementInstance;
      submit?: () => Promise<{ error?: { message?: string } }>;
    };
    confirmPayment: (options: Record<string, unknown>) => Promise<{
      error?: { message?: string };
      paymentIntent?: { status?: string };
    }>;
  };
};

type BumpDef = { sku: string; name: string; unitAmount: number };

const config = document.querySelector<HTMLElement>('[data-page-config="checkout"]');

if (config) {
  const funnelKey = config.dataset.funnelKey ?? "starter-funnel";
  const stripePublishableKey = config.dataset.stripePublishableKey ?? "";
  const stripeConfigured = config.dataset.stripeConfigured === "true";
  const coreAmount = Number(config.dataset.coreAmount ?? "0");
  const coreSku = config.dataset.coreSku ?? "";
  const currency = config.dataset.currency ?? "pln";

  let bumps: BumpDef[] = [];
  try {
    bumps = JSON.parse(config.dataset.bumps ?? "[]") as BumpDef[];
  } catch {
    bumps = [];
  }

  const bumpAddToCartFired = new Set<string>();

  const form = document.querySelector<HTMLFormElement>("#lead-form");
  const bumpToggles = Array.from(
    document.querySelectorAll<HTMLInputElement>("[data-bump-toggle]")
  );
  const prepareButton = document.querySelector<HTMLButtonElement>("#prepare-button");
  const payButton = document.querySelector<HTMLButtonElement>("#pay-button");
  const demoButton = document.querySelector<HTMLButtonElement>("#demo-button");
  const demoShell = document.querySelector<HTMLDivElement>("#demo-shell");
  const paymentPanel = document.querySelector<HTMLDivElement>("#payment-panel");
  const paymentElementMount = document.querySelector<HTMLDivElement>("#payment-element");
  const summaryTotalFigure = document.querySelector<HTMLSpanElement>("#summary-total-figure");
  const summaryTotalInline = document.querySelector<HTMLSpanElement>("#summary-total-inline");
  const checkoutStatus = document.querySelector<HTMLDivElement>("#checkout-status");
  const paymentModeLabel = document.querySelector<HTMLSpanElement>("#payment-mode-label"); // removed from DOM, kept var to avoid wider refactor
  const stripeWindow = window as StripeWindow;

  let leadId = "";
  let funnelSessionId = "";
  // Server-resolved discount from /api/checkout/intents — null until the first
  // intent response, then mirrors whatever the server applied. Drives the
  // discount summary row + the displayed total.
  let activeDiscount: CheckoutDiscount | null = null;
  // Promo code from `?promo=` URL param. Server looks it up in Stripe;
  // codes that aren't active there are silently ignored (no error, no discount).
  const promoCode = (() => {
    try {
      const value = new URLSearchParams(window.location.search).get("promo");
      return value ? value.trim().toUpperCase() : undefined;
    } catch {
      return undefined;
    }
  })();

  // Prefill name + email from URL params when the buyer arrives via a
  // recovery / nurture email. `?n={$name}` → first name, `?he={$email}` →
  // email (we share the param with HYROS attribution since both want the same
  // value). Only fires if the relevant input is currently empty so we never
  // clobber what the user already typed on this device.
  (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const nameFromUrl = params.get("n")?.trim();
      const emailFromUrl = params.get("he")?.trim() ?? params.get("e")?.trim();
      const emailInput = form?.querySelector<HTMLInputElement>("#email");
      const firstNameInput = form?.querySelector<HTMLInputElement>("#firstName");
      if (emailInput && emailFromUrl && !emailInput.value) {
        emailInput.value = emailFromUrl;
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (firstNameInput && nameFromUrl && !firstNameInput.value) {
        firstNameInput.value = nameFromUrl;
        firstNameInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {
      // ignore (URL parsing failures, etc.)
    }
  })();
  // Persist checkoutAttemptId across refreshes so the server can update the
  // existing attempt instead of trying to insert a duplicate (PaymentIntent IDs
  // have a UNIQUE constraint and Stripe idempotency returns the same PI).
  const CHECKOUT_ATTEMPT_KEY = "lts.checkout_attempt_id";
  let checkoutAttemptId = (() => {
    try {
      return window.sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY) ?? "";
    } catch {
      return "";
    }
  })();
  let leadStartedTracked = false;
  let stripeInstance: ReturnType<NonNullable<StripeWindow["Stripe"]>> | null = null;
  let stripeElements: ReturnType<ReturnType<NonNullable<StripeWindow["Stripe"]>>["elements"]> | null = null;
  // Debounced auto-refresh of Payment Element when cart contents change (bump
  // toggles). Coalesces rapid toggles so we don't spam /api/checkout/intents.
  let bumpReFetchTimer: number | null = null;
  let paymentElement: StripeElementInstance | null = null;
  let expressCheckoutElement: StripeElementInstance | null = null;

  // Cookie set by Astro middleware is the source of truth. Falls back to
  // localStorage only for users that landed before the middleware shipped.
  const getAnonymousId = () => config.dataset.anonymousId || readAnonymousId();

  const LEAD_SESSION_KEY = "lts.lead_session";
  type StoredLeadSession = {
    leadId: string;
    funnelSessionId: string;
    email: string;
    firstName?: string;
    capturedAt: string;
  };

  // 30 days. Long enough to cover the full recovery + nurture window
  // (~70 days of nurture is past the cookie's lifetime — that's fine, those
  // emails come with `?n=&he=` URL params as the cross-device fallback).
  const LEAD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const readStoredLeadSession = (): StoredLeadSession | null => {
    // Prefer sessionStorage (current tab's source of truth), fall back to
    // localStorage so a buyer who opts in on day 1 and returns on day 3 from
    // a recovery email click gets prefilled without depending on URL params.
    const tryParse = (raw: string | null): StoredLeadSession | null => {
      try {
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredLeadSession;
        if (!parsed?.leadId || !parsed?.funnelSessionId) return null;
        if (parsed.capturedAt) {
          const ageMs = Date.now() - new Date(parsed.capturedAt).getTime();
          if (Number.isFinite(ageMs) && ageMs > LEAD_SESSION_TTL_MS) return null;
        }
        return parsed;
      } catch {
        return null;
      }
    };
    try {
      return tryParse(window.sessionStorage.getItem(LEAD_SESSION_KEY))
        ?? tryParse(window.localStorage.getItem(LEAD_SESSION_KEY));
    } catch {
      return null;
    }
  };

  const writeStoredLeadSession = (session: StoredLeadSession) => {
    const payload = JSON.stringify(session);
    try {
      window.sessionStorage.setItem(LEAD_SESSION_KEY, payload);
    } catch {
      // ignore (private mode etc.)
    }
    try {
      window.localStorage.setItem(LEAD_SESSION_KEY, payload);
    } catch {
      // ignore (private mode etc.)
    }
  };

  const stored = readStoredLeadSession();
  if (stored) {
    leadId = stored.leadId;
    funnelSessionId = stored.funnelSessionId;
    const firstNameInput = form?.querySelector<HTMLInputElement>("#firstName");
    const emailInput = form?.querySelector<HTMLInputElement>("#email");
    if (firstNameInput && stored.firstName) firstNameInput.value = stored.firstName;
    if (emailInput && stored.email) emailInput.value = stored.email;
  }

  const anonymousId = getAnonymousId();

  initFunnelAnalytics({
    posthogKey: config.dataset.posthogKey ?? "",
    apiHost: config.dataset.apiHost ?? "",
    metaPixelId: config.dataset.metaPixelId ?? "",
    anonymousId,
    superProperties: {
      funnel_key: funnelKey,
      ...(stored?.leadId ? { lead_id: stored.leadId } : {}),
      ...(stored?.funnelSessionId ? { funnel_session_id: stored.funnelSessionId } : {})
    }
  });

  if (stored?.leadId) {
    identifyAnalytics(anonymousId, {
      lead_id: stored.leadId,
      funnel_session_id: stored.funnelSessionId,
      funnel_key: funnelKey,
      email: stored.email,
      first_name: stored.firstName ?? null
    });
  }

  wireScrollTracking();

  const formatMoney = (amount: number) =>
    new Intl.NumberFormat("pl-PL", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount / 100);

  const getSelectedBumpSkus = () =>
    bumpToggles.filter((t) => t.checked).map((t) => t.dataset.bumpSku ?? "").filter(Boolean);

  const getTotalAmount = () => {
    const selected = new Set(getSelectedBumpSkus());
    return bumps.reduce((sum, b) => (selected.has(b.sku) ? sum + b.unitAmount : sum), coreAmount);
  };

  const hashValue = async (value: string) => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };

  const showStatus = (message: string, tone: "" | "error" | "success" = "") => {
    if (!checkoutStatus) {
      return;
    }

    checkoutStatus.hidden = false;
    checkoutStatus.className = tone ? `status-banner ${tone}` : "status-banner";
    checkoutStatus.textContent = message;
  };

  const clearPaymentMount = () => {
    paymentElement?.destroy?.();
    paymentElement = null;
    expressCheckoutElement?.destroy?.();
    expressCheckoutElement = null;
    stripeElements = null;

    if (paymentElementMount) {
      paymentElementMount.innerHTML = "";
    }
    const expressMount = document.querySelector<HTMLDivElement>("#express-checkout-element");
    if (expressMount) expressMount.innerHTML = "";
  };

  const discountRow = document.querySelector<HTMLDivElement>("#summary-discount-row");
  const discountLabel = document.querySelector<HTMLSpanElement>("#summary-discount-label");
  const discountFigure = document.querySelector<HTMLSpanElement>("#summary-discount-figure");

  const refreshSummary = () => {
    const selected = new Set(getSelectedBumpSkus());
    for (const row of document.querySelectorAll<HTMLDivElement>("[data-summary-bump-sku]")) {
      const sku = row.dataset.summaryBumpSku ?? "";
      row.hidden = !selected.has(sku);
    }
    for (const card of document.querySelectorAll<HTMLElement>("[data-bump-card]")) {
      const sku = card.dataset.bumpCard ?? "";
      card.classList.toggle("is-selected", selected.has(sku));
    }

    const subtotal = getTotalAmount();
    const discountAmount = activeDiscount?.amount ?? 0;
    const total = Math.max(0, subtotal - discountAmount);

    if (discountRow && discountLabel && discountFigure) {
      if (activeDiscount && discountAmount > 0) {
        discountRow.hidden = false;
        discountLabel.textContent = `Rabat ${activeDiscount.promoCode}`;
        discountFigure.textContent = `−${formatMoney(discountAmount)}`;
      } else {
        discountRow.hidden = true;
      }
    }

    if (summaryTotalFigure) summaryTotalFigure.textContent = formatMoney(total);
    if (summaryTotalInline) summaryTotalInline.textContent = formatMoney(total);
    if (payButton) payButton.textContent = `Pay ${formatMoney(total)}`;
  };

  const fetchJson = async <T>(url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? payload.message ?? "Request failed");
    }
    return payload as T;
  };

  const loadStripeJs = async () => {
    if (stripeWindow.Stripe) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>('script[src="https://js.stripe.com/v3/"]');

      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener("error", () => reject(new Error("Stripe.js failed to load")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Stripe.js failed to load")), { once: true });
      document.head.append(script);
    });
  };

  const mountStripePayment = async (intent: CheckoutIntentResponse) => {
    if (!paymentPanel || !demoShell || !payButton) {
      return;
    }

    paymentPanel.hidden = false;
    demoShell.hidden = true;
    payButton.hidden = false;
    if (paymentModeLabel) paymentModeLabel.textContent = "stripe";

    // Hide the "Przejdź do płatności" prepare button — Payment Element is now mounted,
    // so the "Pay X" button is the actual submit. Two buttons would be confusing.
    if (prepareButton) prepareButton.hidden = true;

    if (!stripeInstance) {
      await loadStripeJs();

      if (!stripeWindow.Stripe) {
        throw new Error("Stripe.js did not load");
      }

      stripeInstance = stripeWindow.Stripe(stripePublishableKey);
    }

    clearPaymentMount();
    stripeElements = stripeInstance.elements({
      clientSecret: intent.clientSecret,
      appearance: {
        theme: "night",
        variables: {
          colorPrimary: "#ec3a93",
          colorBackground: "#11050d",
          colorText: "#ffffff",
          colorTextSecondary: "rgba(255, 255, 255, 0.74)",
          colorTextPlaceholder: "rgba(255, 255, 255, 0.36)",
          colorDanger: "#ff6b8a",
          colorIconTab: "#ffffff",
          colorIconTabSelected: "#ec3a93",
          borderRadius: "14px",
          fontFamily: "Inter, Arial, Helvetica, sans-serif"
        },
        rules: {
          ".Input": {
            backgroundColor: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "#ffffff",
            boxShadow: "none"
          },
          ".Input:focus": {
            borderColor: "rgba(236, 58, 147, 0.7)",
            boxShadow: "0 0 0 3px rgba(236, 58, 147, 0.22)"
          },
          ".Tab": {
            backgroundColor: "rgba(255, 255, 255, 0.04)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "#ffffff"
          },
          ".Tab:hover": { backgroundColor: "rgba(255, 255, 255, 0.07)" },
          ".Tab--selected": {
            borderColor: "rgba(236, 58, 147, 0.7)",
            boxShadow: "0 0 0 1px rgba(236, 58, 147, 0.45)"
          },
          // Bigger TabIcon for tabs layout
          ".TabIcon": {
            transform: "scale(1.4)"
          },
          // Bigger AccordionItem — more padding + larger font scales icons
          ".AccordionItem": {
            padding: "18px 18px",
            fontSize: "16px"
          },
          // Brand logos (BLIK, Visa, Mastercard, Klarna, P24 etc.)
          ".Logo": {
            transform: "scale(1.3)",
            transformOrigin: "left center"
          },
          ".Label": {
            color: "rgba(255, 255, 255, 0.74)",
            textTransform: "uppercase",
            fontWeight: "600",
            letterSpacing: "0.04em",
            fontSize: "0.84rem"
          }
        }
      }
    });

    // Pre-fill billing details from the lead session — user already gave email,
    // no point asking again inside BLIK / cards.
    const storedEmailForPayment =
      (form?.querySelector<HTMLInputElement>("#email")?.value.trim() ?? "") ||
      readStoredLeadSession()?.email ||
      "";
    const storedFirstName =
      (form?.querySelector<HTMLInputElement>("#firstName")?.value.trim() ?? "") ||
      readStoredLeadSession()?.firstName ||
      "";

    // Express Checkout Element mounts ABOVE the accordion. It only renders
    // wallet buttons that the browser/Stripe combination can handle. On Safari
    // it stays empty (Apple Pay shows in the accordion instead). On Chrome on
    // Mac it shows the Apple Pay button (with QR-code cross-device pay) and
    // Google Pay button. Empty mount auto-collapses via CSS (:empty).
    expressCheckoutElement = stripeElements.create("expressCheckout", {
      paymentMethods: {
        applePay: "always",
        googlePay: "always",
        link: "never",
        paypal: "never",
        amazonPay: "never",
        klarna: "never"
      },
      buttonHeight: 48,
      // Stripe enforces: overflow:"never" requires maxRows:0 (= no cap).
      // We only render Apple Pay + Google Pay here, so there are at most two
      // buttons and no overflow row appears in practice.
      layout: {
        maxColumns: 2,
        maxRows: 0,
        overflow: "never"
      }
    });
    expressCheckoutElement.on?.("confirm", async () => {
      try {
        showStatus("Przetwarzam płatność…");
        const { error } = await stripeInstance!.confirmPayment({
          elements: stripeElements,
          clientSecret: intent.clientSecret,
          confirmParams: {
            return_url: `${window.location.origin}/checkout?return=1`,
            // Stripe requires billing_details.email here because we set
            // fields.billingDetails.email = "never" on the Payment Element
            // (we already collected email at the lead capture step).
            payment_method_data: {
              billing_details: {
                email: storedEmailForPayment,
                ...(storedFirstName ? { name: storedFirstName } : {})
              }
            }
          },
          redirect: "if_required"
        });
        if (error) throw new Error(error.message ?? "Payment failed");
        showStatus("Payment accepted. Redirecting...", "success");
        await waitForCheckoutResolution();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Payment failed.", "error");
      }
    });
    expressCheckoutElement.mount("#express-checkout-element");

    paymentElement = stripeElements.create("payment", {
      layout: {
        type: "accordion",
        defaultCollapsed: false,
        radios: true,
        spacedAccordionItems: false
      },
      // Order in accordion list. Wallets first (highest conversion when
      // natively supported by the browser), then BLIK, card, and the
      // redirect-based options (klarna, p24, paypal) at the bottom.
      paymentMethodOrder: ["apple_pay", "google_pay", "blik", "card", "klarna", "p24", "paypal"],
      // Hide email field only when we actually have it from lead capture —
      // otherwise let Stripe collect it (otherwise confirmPayment errors with
      // "did not pass confirmParams.payment_method_data.billing_details.email").
      fields: {
        billingDetails: {
          email: storedEmailForPayment ? "never" : "auto"
        }
      },
      defaultValues: {
        billingDetails: {
          email: storedEmailForPayment,
          name: storedFirstName || undefined
        }
      },
      // Payment Element only accepts 'auto' or 'never' for wallets.
      // The 'always' option (which enables Apple Pay QR-code on non-Safari browsers)
      // is exclusive to Express Checkout Element. To get cross-browser Apple Pay,
      // we'd need to add ExpressCheckoutElement as a separate component above this one.
      wallets: {
        applePay: "auto",
        googlePay: "auto"
      }
    });
    paymentElement.mount("#payment-element");

    // Fire Payment Info Entered on first interaction with the Element, not on
    // mount. Per PostHog ecommerce spec the event represents the user actively
    // entering payment info — emitting on mount would inflate the rate. Mirror
    // the same signal to Meta as the standard `AddPaymentInfo` event so Meta
    // can optimise for high-intent users who started filling in card details.
    let paymentInfoEnteredFired = false;
    paymentElement.on?.("focus", () => {
      if (paymentInfoEnteredFired) return;
      paymentInfoEnteredFired = true;
      captureAnalyticsEvent("Payment Info Entered", {
        checkout_id: checkoutAttemptId,
        funnel_session_id: funnelSessionId,
        payment_method: "stripe"
      });

      if (!leadId || !funnelSessionId) return;
      const totalAmount = intent.quote.totalAmount;
      const eventId = metaEventId("add_payment_info", checkoutAttemptId);
      const items = intent.quote.items.map((i) => ({
        id: i.sku,
        quantity: 1,
        item_price: i.unitAmount / 100
      }));
      trackMeta("AddPaymentInfo", eventId, {
        currency: intent.quote.currency.toLowerCase(),
        value: totalAmount / 100,
        content_type: "product",
        content_ids: items.map((i) => i.id),
        contents: items,
        num_items: items.length,
        checkout_attempt_id: checkoutAttemptId,
        funnel_session_id: funnelSessionId
      });

      const { fbp, fbc } = readFbCookies();
      const beaconBody = JSON.stringify({
        eventId,
        leadId,
        funnelSessionId,
        checkoutAttemptId,
        amount: totalAmount,
        currency: intent.quote.currency,
        contentIds: items.map((i) => i.id),
        fbp,
        fbc
      });
      try {
        const blob = new Blob([beaconBody], { type: "application/json" });
        if (!navigator.sendBeacon || !navigator.sendBeacon("/api/meta/add-payment-info", blob)) {
          void fetch("/api/meta/add-payment-info", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: beaconBody,
            keepalive: true
          }).catch(() => undefined);
        }
      } catch {
        // ignore beacon failure; pixel fired client-side anyway
      }
    });
  };

  const revealDemoMode = () => {
    if (!paymentPanel || !paymentModeLabel || !demoShell || !payButton) {
      return;
    }

    clearPaymentMount();
    paymentPanel.hidden = false;
    payButton.hidden = true;
    demoShell.hidden = false;
    paymentModeLabel.textContent = "demo";

    captureAnalyticsEvent("Payment Info Entered", {
      checkout_id: checkoutAttemptId,
      funnel_session_id: funnelSessionId,
      payment_method: "demo"
    });
  };

  const waitForCheckoutResolution = async () => {
    if (!checkoutAttemptId) {
      throw new Error("Missing checkout attempt id");
    }

    for (let attempt = 0; attempt < 18; attempt += 1) {
      const status = await fetchJson<CheckoutStatusResponse>(`/api/checkout/status/${checkoutAttemptId}`);

      if (status.nextUrl) {
        window.location.assign(status.nextUrl);
        return;
      }

      if (status.status === "failed") {
        throw new Error("Payment failed. Spróbuj inną metodę.");
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }

    throw new Error("Payment was accepted, but the next step is not ready yet. Refresh in a moment.");
  };

  const ensureLeadSession = async () => {
    const emailInput = form?.querySelector<HTMLInputElement>("#email");
    const firstNameInput = form?.querySelector<HTMLInputElement>("#firstName");

    const typedEmail = emailInput?.value.trim() ?? "";
    const currentFirstName = firstNameInput?.value.trim() || undefined;

    // Use an anonymous placeholder when the user hasn't entered an email yet.
    // Lets us create a lead + PaymentIntent so the Payment Element can mount
    // BEFORE the user types anything. The lead is updated when they enter a
    // real address.
    const currentEmail =
      typedEmail || `anon-${getAnonymousId()}@checkout.local`;

    if (leadId && funnelSessionId) {
      const previous = readStoredLeadSession();
      const sameEmail = previous?.email === currentEmail;
      const sameFirstName = (previous?.firstName ?? undefined) === currentFirstName;
      if (sameEmail && sameFirstName) {
        return;
      }
    }

    const anonymousId = getAnonymousId();
    const userAgentHash = await hashValue(navigator.userAgent || "unknown");
    const ipHash = await hashValue("client-ip-unavailable");
    const sourcePage = `${window.location.pathname}${window.location.search}`;
    const timestamp = new Date().toISOString();

    const lead = await fetchJson<LeadCaptureResponse>("/api/leads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...metaForwardHeaders()
      },
      body: JSON.stringify({
        identity: {
          email: currentEmail,
          firstName: currentFirstName,
          anonymousId,
          sourcePage,
          funnelKey
        },
        consent: {
          status: "granted",
          sourcePage,
          ipHash,
          userAgentHash,
          timestamp
        }
      })
    });

    leadId = lead.leadId;
    funnelSessionId = lead.funnelSessionId;
    fireDeferredCartEvents();

    writeStoredLeadSession({
      leadId,
      funnelSessionId,
      email: currentEmail,
      firstName: currentFirstName,
      capturedAt: timestamp
    });

    identifyAnalytics(anonymousId, {
      lead_id: leadId,
      funnel_session_id: funnelSessionId,
      funnel_key: funnelKey,
      email: currentEmail,
      first_name: currentFirstName ?? null
    });
    setUserProperties(
      {
        email: currentEmail,
        first_name: currentFirstName ?? null,
        funnel_key: funnelKey,
        lead_id: leadId
      },
      {
        first_seen_at: timestamp,
        first_landing_path: sourcePage
      }
    );

    if (lead.metaEventIds?.lead) {
      trackMeta("Lead", lead.metaEventIds.lead, {
        content_name: funnelKey,
        funnel_session_id: funnelSessionId
      });
    }
  };

  form?.addEventListener("focusin", () => {
    if (leadStartedTracked) {
      return;
    }

    leadStartedTracked = true;
    captureAnalyticsEvent("Lead Started", {
      funnel_key: funnelKey,
      source_page: window.location.pathname
    });
  });

  // Cart Viewed: PostHog ecommerce spec — fire once on checkout mount with the
  // current cart contents (core + any toggled-on bumps). Uses funnel_session_id
  // as cart_id once the lead exists, falls back to checkoutAttemptId.
  const buildCartProducts = () => {
    const selected = new Set(getSelectedBumpSkus());
    const products: Array<Record<string, unknown>> = [
      {
        product_id: coreSku,
        sku: coreSku,
        name: config?.dataset.coreName ?? "",
        category: "core",
        price: coreAmount / 100,
        quantity: 1
      }
    ];
    for (const b of bumps) {
      if (selected.has(b.sku)) {
        products.push({
          product_id: b.sku,
          sku: b.sku,
          name: b.name,
          category: "order_bump",
          price: b.unitAmount / 100,
          quantity: 1
        });
      }
    }
    return products;
  };

  let cartViewedFired = false;
  let couponEnteredFired = false;
  const fireDeferredCartEvents = () => {
    if (!funnelSessionId) return;
    if (!cartViewedFired) {
      cartViewedFired = true;
      captureAnalyticsEvent("Cart Viewed", {
        cart_id: funnelSessionId,
        currency: currency.toLowerCase(),
        products: buildCartProducts()
      });
    }
    if (promoCode && !couponEnteredFired) {
      couponEnteredFired = true;
      captureAnalyticsEvent("Coupon Entered", {
        cart_id: funnelSessionId,
        coupon_id: promoCode
      });
    }
  };
  // If we already restored a lead session from localStorage, fire immediately.
  // Otherwise we defer until ensureLeadSession resolves and assigns funnelSessionId.
  if (funnelSessionId) fireDeferredCartEvents();

  for (const toggle of bumpToggles) {
    toggle.addEventListener("change", () => {
      refreshSummary();

      const sku = toggle.dataset.bumpSku ?? "";
      const bump = bumps.find((b) => b.sku === sku);
      if (bump) {
        // PostHog ecommerce spec: Product Added on toggle ON, Product Removed
        // on toggle OFF. Fires every flip (no dedupe set) so PostHog gets the
        // honest cart-shape over time; revenue is still gated on Order Completed.
        captureAnalyticsEvent(toggle.checked ? "Product Added" : "Product Removed", {
          cart_id: funnelSessionId || checkoutAttemptId || anonymousId,
          product_id: sku,
          sku,
          name: bump.name,
          category: "order_bump",
          price: bump.unitAmount / 100,
          quantity: 1
        });
      }
      if (toggle.checked && bump && !bumpAddToCartFired.has(sku) && funnelSessionId && leadId) {
        bumpAddToCartFired.add(sku);
        const eventId = metaEventId("addtocart", `${funnelSessionId}:${sku}`);
        trackMeta("AddToCart", eventId, {
          currency: currency.toLowerCase(),
          value: bump.unitAmount / 100,
          content_type: "product",
          content_ids: [sku],
          content_name: bump.name,
          contents: [{ id: sku, quantity: 1, item_price: bump.unitAmount / 100 }],
          num_items: 1,
          funnel_session_id: funnelSessionId
        });

        const beaconBody = JSON.stringify({
          eventId,
          leadId,
          funnelSessionId,
          sku,
          name: bump.name,
          amount: bump.unitAmount,
          currency
        });
        try {
          const blob = new Blob([beaconBody], { type: "application/json" });
          if (!navigator.sendBeacon || !navigator.sendBeacon("/api/meta/order-bump", blob)) {
            void fetch("/api/meta/order-bump", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: beaconBody,
              keepalive: true
            }).catch(() => undefined);
          }
        } catch {
          // ignore
        }
      }

      if (checkoutAttemptId) {
        // Auto-refresh Payment Element with the new cart total. Hide the old
        // one immediately so the user can't click the now-stale pay button,
        // then debounce 400 ms and re-trigger the form submit handler — which
        // re-fetches /api/checkout/intents and re-mounts Payment Element with
        // the fresh PI client_secret.
        clearPaymentMount();
        if (paymentPanel) paymentPanel.hidden = true;
        if (demoShell) demoShell.hidden = true;
        if (payButton) payButton.hidden = true;
        showStatus("Aktualizuję płatność…");

        if (bumpReFetchTimer !== null) {
          window.clearTimeout(bumpReFetchTimer);
        }
        bumpReFetchTimer = window.setTimeout(() => {
          bumpReFetchTimer = null;
          form?.requestSubmit();
        }, 400);
      }
    });
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();

    void (async () => {
      try {
        prepareButton?.setAttribute("disabled", "disabled");
        // No "preparing" status — Payment Element renders fast enough that the
        // banner is just visual noise. Errors will still show.
        if (checkoutStatus) checkoutStatus.hidden = true;

        await ensureLeadSession();

        const selectedBumpSkus = getSelectedBumpSkus();

        const intent = await fetchJson<CheckoutIntentResponse>("/api/checkout/intents", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...metaForwardHeaders()
          },
          body: JSON.stringify({
            leadId,
            funnelSessionId,
            funnelKey,
            selectedBumpSkus,
            checkoutAttemptId: checkoutAttemptId || undefined,
            promoCode
          })
        });

        checkoutAttemptId = intent.checkoutAttemptId;
        activeDiscount = intent.quote.discount ?? null;
        try {
          window.sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY, checkoutAttemptId);
        } catch {
          // ignore (private mode etc.)
        }
        refreshSummary();

        if (intent.metaEventIds?.initiateCheckout) {
          const totalAmount = intent.quote.totalAmount;
          const items = intent.quote.items.map((i) => ({
            id: i.sku,
            quantity: 1,
            item_price: i.unitAmount / 100
          }));
          trackMeta("InitiateCheckout", intent.metaEventIds.initiateCheckout, {
            currency: intent.quote.currency.toLowerCase(),
            value: totalAmount / 100,
            content_type: "product",
            content_ids: items.map((i) => i.id),
            contents: items,
            num_items: items.length,
            checkout_attempt_id: intent.checkoutAttemptId,
            funnel_session_id: funnelSessionId
          });
        }

        if (stripeConfigured && !intent.clientSecret.startsWith("demo_")) {
          await mountStripePayment(intent);
          // No success banner — Payment Element appearing IS the success signal.
        } else {
          revealDemoMode();
          // No banner for demo either; the demo button is self-explanatory.
        }
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Could not prepare payment.", "error");
      } finally {
        prepareButton?.removeAttribute("disabled");
      }
    })();
  });

  payButton?.addEventListener("click", () => {
    void (async () => {
      if (!stripeInstance || !stripeElements) {
        showStatus("Stripe Payment Element jeszcze się nie załadował.", "error");
        return;
      }

      try {
        payButton.setAttribute("disabled", "disabled");
        showStatus("Przetwarzam płatność…");

        // Re-read billing details fresh from the form / lead session — this
        // handler outlives mountStripePayment's closure, and the user might
        // have edited the form fields after Payment Element mounted.
        const liveEmail =
          (form?.querySelector<HTMLInputElement>("#email")?.value.trim() ?? "") ||
          readStoredLeadSession()?.email ||
          "";
        const liveFirstName =
          (form?.querySelector<HTMLInputElement>("#firstName")?.value.trim() ?? "") ||
          readStoredLeadSession()?.firstName ||
          "";

        const { error, paymentIntent } = await stripeInstance.confirmPayment({
          elements: stripeElements,
          confirmParams: {
            // Required for redirect-based methods such as P24, Klarna, and
            // PayPal. Stripe rejects confirmPayment when the selected method
            // needs a redirect and no return_url is supplied.
            return_url: `${window.location.origin}/checkout?return=1`,
            // Required because Payment Element was created with
            // fields.billingDetails.email = "never" — we own the email field
            // (lead capture step) so Stripe needs it explicitly here.
            payment_method_data: {
              billing_details: {
                email: liveEmail,
                ...(liveFirstName ? { name: liveFirstName } : {})
              }
            }
          },
          redirect: "if_required"
        });

        if (error) {
          throw new Error(error.message ?? "Payment failed");
        }

        if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "processing") {
          showStatus("Payment accepted. Redirecting...", "success");
          await waitForCheckoutResolution();
          return;
        }

        throw new Error("Stripe zwrócił nieoczekiwany stan płatności.");
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Payment failed.", "error");
      } finally {
        payButton.removeAttribute("disabled");
      }
    })();
  });

  demoButton?.addEventListener("click", () => {
    void (async () => {
      try {
        demoButton.setAttribute("disabled", "disabled");
        showStatus("Symuluję udaną płatność…");

        const result = await fetchJson<CheckoutStatusResponse>("/api/checkout/demo-complete", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            checkoutAttemptId
          })
        });

        if (!result.nextUrl) {
          throw new Error("Demo zakończyło się, ale nie zwróciło URL kolejnego kroku.");
        }

        window.location.assign(result.nextUrl);
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Demo płatność nie powiodła się.", "error");
      } finally {
        demoButton.removeAttribute("disabled");
      }
    })();
  });

  // Suppress unused warnings on coreSku — kept for future analytics extensions.
  void coreSku;

  refreshSummary();

  // ===== MOBILE STICKY SHEET =====
  const mobileSheet = document.querySelector<HTMLDivElement>("#mobile-summary-sheet");
  const mobileSheetToggle = document.querySelector<HTMLButtonElement>("#mobile-sheet-toggle");
  const mobileSheetBody = document.querySelector<HTMLDivElement>("#mobile-sheet-body");
  const mobileSheetBackdrop = document.querySelector<HTMLDivElement>("#mobile-sheet-backdrop");
  const mobileSheetExtra = document.querySelector<HTMLElement>("#mobile-sheet-extra");
  const mobileSheetTotal = document.querySelector<HTMLElement>("#mobile-sheet-total");
  const summarySource = document.querySelector<HTMLElement>(".co-summary-sticky");

  if (mobileSheet) {
    mobileSheet.hidden = false;
  }

  const syncMobileSheetBody = () => {
    if (!mobileSheetBody || !summarySource) return;
    mobileSheetBody.innerHTML = summarySource.innerHTML;
  };

  const mobileSheetBadge = document.querySelector<HTMLElement>("#mobile-sheet-badge");
  const mobileSheetProduct = document.querySelector<HTMLElement>("#mobile-sheet-product");

  const refreshMobileSheetBar = () => {
    const bumpCount = getSelectedBumpSkus().length;
    const totalProducts = 1 + bumpCount;

    if (mobileSheetTotal) {
      const discountAmount = activeDiscount?.amount ?? 0;
      const total = Math.max(0, getTotalAmount() - discountAmount);
      mobileSheetTotal.textContent = formatMoney(total);
    }
    if (mobileSheetBadge) {
      mobileSheetBadge.textContent = String(totalProducts);
    }
    if (mobileSheetExtra) {
      // Top label: short pretty status
      mobileSheetExtra.textContent = bumpCount === 0
        ? "Your order"
        : `Z ${bumpCount} ${bumpCount === 1 ? "dodatkiem" : "dodatkami"}`;
    }
    if (mobileSheetProduct) {
      // Bottom strong: product line — core + count if bumps
      const coreName = config?.dataset.coreName ?? "Twój produkt";
      mobileSheetProduct.textContent = bumpCount === 0
        ? coreName
        : `${coreName} +${bumpCount}`;
    }
  };

  refreshMobileSheetBar();
  syncMobileSheetBody();

  // Re-sync after bump toggles change anything
  for (const toggle of bumpToggles) {
    toggle.addEventListener("change", () => {
      window.setTimeout(() => {
        refreshMobileSheetBar();
        syncMobileSheetBody();
      }, 0);
    });
  }

  const setSheetOpen = (open: boolean) => {
    if (!mobileSheet) return;
    mobileSheet.dataset.open = open ? "true" : "false";
    if (mobileSheetToggle) {
      mobileSheetToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    document.body.style.overflow = open ? "hidden" : "";
  };

  mobileSheetToggle?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = mobileSheet?.dataset.open === "true";
    setSheetOpen(!isOpen);
  });

  mobileSheetBackdrop?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSheetOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mobileSheet?.dataset.open === "true") {
      setSheetOpen(false);
    }
  });

  // Auto-mount Payment Element on every page load — even before the user
  // enters anything. ensureLeadSession() falls back to an anonymous placeholder
  // email when the field is empty, so the PaymentIntent can be created and
  // Stripe Element rendered immediately.
  window.setTimeout(() => {
    try {
      form?.requestSubmit();
    } catch {
      // ignore
    }
  }, 50);

  // Re-submit when the user types a real email so we update the lead.
  const emailInput = form?.querySelector<HTMLInputElement>("#email");
  if (emailInput) {
    let debounceHandle: number | undefined;
    const handleEmailChange = () => {
      window.clearTimeout(debounceHandle);
      const value = emailInput.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return;
      debounceHandle = window.setTimeout(() => {
        try {
          form?.requestSubmit();
        } catch {
          // ignore
        }
      }, 500);
    };
    emailInput.addEventListener("input", handleEmailChange);
    emailInput.addEventListener("blur", handleEmailChange);
  }
}
