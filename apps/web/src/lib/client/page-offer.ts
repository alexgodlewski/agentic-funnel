import {
  captureAnalyticsEvent,
  identifyAnalytics,
  initFunnelAnalytics,
  readAnonymousId,
  wireScrollTracking
} from "./analytics";
import { metaForwardHeaders, trackMeta } from "./meta-pixel";

type OfferDecisionResponse = {
  status: string;
  nextStep: "downsell" | "thank_you";
  nextToken?: string;
  orderId: string;
  metaEventId?: string;
  purchaseMetaEventId?: string;
  purchaseValue?: number;
  purchaseCurrency?: string;
  purchaseContents?: Array<{ id: string; quantity: number; item_price: number }>;
  purchaseNumItems?: number;
  /** Set by server when buyer's saved PM is single-use (BLIK / P24). */
  paymentAction?: {
    method: "blik" | "p24";
    clientSecret: string;
    paymentIntentId: string;
  };
};

type StripeJsResult = {
  error?: { message?: string };
  paymentIntent?: { status?: string };
};
type StripeJsInstance = {
  confirmBlikPayment: (clientSecret: string, params: unknown) => Promise<StripeJsResult>;
  confirmP24Payment: (clientSecret: string, params: unknown) => Promise<StripeJsResult>;
};
type StripeWindow = Window & {
  Stripe?: (key: string, options?: { locale?: string }) => StripeJsInstance;
};

const config = document.querySelector<HTMLElement>('[data-page-config="offer"]');

if (config) {
  const token = config.dataset.token ?? "";
  const orderId = config.dataset.orderId ?? "";
  const expiresAt = config.dataset.expiresAt ?? "";
  const offerKind = config.dataset.offerKind === "downsell" ? "downsell" : "oto";
  const viewEventId = config.dataset.metaViewEventId ?? "";
  const offerSku = config.dataset.offerSku ?? "";
  const offerName = config.dataset.offerName ?? "";
  const offerAmountCents = Number(config.dataset.offerAmount ?? "0");
  // Currency comes from the order row server-side (sourced from Stripe at PI
  // creation), so it's authoritative for this funnel run. No env var fallback —
  // missing data-currency means the server contract changed and we want the
  // failure to be visible (empty string in pixels).
  const currency = (config.dataset.currency ?? "").toLowerCase();
  const acceptButton = document.querySelector<HTMLButtonElement>("#accept-offer");
  const declineButton = document.querySelector<HTMLButtonElement>("#decline-offer");
  const timer = document.querySelector<HTMLDivElement>("#offer-timer");
  const status = document.querySelector<HTMLDivElement>("#offer-status");
  const stripePublishableKey = config.dataset.stripePublishableKey ?? "";
  const buyerEmail = config.dataset.buyerEmail ?? "";

  // Stripe.js bookkeeping for BLIK / P24 re-prompts. Loaded lazily on first
  // accept click — cards never need it (off_session charge happens server-side).
  const stripeWindow = window as unknown as StripeWindow;
  let stripeInstance: StripeJsInstance | null = null;

  const loadStripeJs = async () => {
    if (stripeWindow.Stripe) return;
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src="https://js.stripe.com/v3/"]'
      );
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error("Stripe.js failed to load")),
          { once: true }
        );
        return;
      }
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("Stripe.js failed to load")),
        { once: true }
      );
      document.head.appendChild(script);
    });
  };

  const ensureStripeInstance = async () => {
    await loadStripeJs();
    if (!stripeInstance && stripeWindow.Stripe && stripePublishableKey) {
      stripeInstance = stripeWindow.Stripe(stripePublishableKey, { locale: "pl" });
    }
    if (!stripeInstance) {
      throw new Error("Stripe nie został zainicjowany.");
    }
    return stripeInstance;
  };

  // BLIK modal — hidden by default; opened when server returns
  // paymentAction.method === "blik".
  const blikModal = document.querySelector<HTMLDivElement>("#blik-modal");
  const blikInput = document.querySelector<HTMLInputElement>("#blik-code");
  const blikConfirm = document.querySelector<HTMLButtonElement>("#blik-confirm");
  const blikCancel = document.querySelector<HTMLButtonElement>("#blik-cancel");
  const blikStatus = document.querySelector<HTMLDivElement>("#blik-status");

  const showBlikStatus = (message: string, tone: "" | "error" | "success" = "") => {
    if (!blikStatus) return;
    blikStatus.hidden = false;
    blikStatus.className = tone ? `status-banner ${tone}` : "status-banner";
    blikStatus.textContent = message;
  };

  const closeBlikModal = () => {
    if (!blikModal) return;
    blikModal.hidden = true;
    document.body.classList.remove("modal-open");
    if (blikStatus) {
      blikStatus.hidden = true;
      blikStatus.textContent = "";
    }
  };

  let blikHandlerWired = false;
  const wireBlikHandlers = (clientSecret: string) => {
    // Each call re-binds because clientSecret changes per attempt. Use
    // capture/once so handlers don't pile up.
    blikHandlerWired = true;
    const onConfirm = async () => {
      const code = (blikInput?.value ?? "").trim();
      if (!/^\d{6}$/.test(code)) {
        showBlikStatus("The payment code must have 6 digits.", "error");
        return;
      }
      try {
        blikConfirm?.toggleAttribute("disabled", true);
        blikCancel?.toggleAttribute("disabled", true);
        showBlikStatus("Sprawdź aplikację banku — czekam na potwierdzenie…");
        const stripe = await ensureStripeInstance();
        const { error } = await stripe.confirmBlikPayment(clientSecret, {
          payment_method: {
            // Empty object tells Stripe to create a fresh BLIK PaymentMethod
            // (we own the code in payment_method_options below).
            blik: {},
            billing_details: buyerEmail ? { email: buyerEmail } : {}
          },
          payment_method_options: {
            blik: { code }
          }
        });
        if (error) {
          showBlikStatus(error.message ?? "Payment confirmation failed.", "error");
          blikConfirm?.removeAttribute("disabled");
          blikCancel?.removeAttribute("disabled");
          return;
        }
        // PI is now 'succeeded' or 'processing'. Webhook finalizes the offer
        // server-side. Redirect; thank-you page handles 'still processing' UI.
        window.location.assign(`/thank-you/${orderId}`);
      } catch (e) {
        showBlikStatus(e instanceof Error ? e.message : "Payment confirmation failed.", "error");
        blikConfirm?.removeAttribute("disabled");
        blikCancel?.removeAttribute("disabled");
      }
    };
    const onCancel = () => {
      closeBlikModal();
      setBusy(false);
    };
    blikConfirm?.addEventListener("click", onConfirm, { once: true });
    blikCancel?.addEventListener("click", onCancel, { once: true });
  };

  const openBlikModal = (clientSecret: string) => {
    if (!blikModal) {
      throw new Error("Payment modal is missing on this page.");
    }
    blikModal.hidden = false;
    document.body.classList.add("modal-open");
    if (blikInput) {
      blikInput.value = "";
      window.requestAnimationFrame(() => blikInput.focus());
    }
    blikConfirm?.removeAttribute("disabled");
    blikCancel?.removeAttribute("disabled");
    if (!blikHandlerWired) {
      wireBlikHandlers(clientSecret);
    } else {
      // Re-wire once handlers were used and detached.
      wireBlikHandlers(clientSecret);
    }
  };

  const triggerP24 = async (clientSecret: string) => {
    const stripe = await ensureStripeInstance();
    const returnUrl = `${window.location.origin}/thank-you/${orderId}`;
    const { error } = await stripe.confirmP24Payment(clientSecret, {
      payment_method: {
        // Empty object → Stripe redirects to its hosted bank-selection page.
        p24: {},
        billing_details: buyerEmail ? { email: buyerEmail } : {}
      },
      return_url: returnUrl
    });
    // confirmP24Payment navigates to the bank on success. If we're still here,
    // an error happened.
    if (error) {
      throw new Error(error.message ?? "Redirect payment failed.");
    }
  };

  const anonymousId = config.dataset.anonymousId || readAnonymousId();
  const funnelKey = config.dataset.funnelKey || "";

  initFunnelAnalytics({
    posthogKey: config.dataset.posthogKey ?? "",
    apiHost: config.dataset.apiHost ?? "",
    metaPixelId: config.dataset.metaPixelId ?? "",
    anonymousId,
    superProperties: {
      order_id: orderId,
      offer_kind: offerKind,
      ...(funnelKey ? { funnel_key: funnelKey } : {})
    }
  });

  // Stay on the same PostHog person (anonymousId). order_id moves to the
  // person properties; we never rotate distinct_id to `order:<id>`.
  if (orderId) {
    identifyAnalytics(anonymousId, { order_id: orderId });
  }

  wireScrollTracking();
  // PostHog ecommerce spec: post-purchase upsell view = `Product Viewed`. The
  // `offer_kind` super-property segments OTO vs downsell views in reports.
  captureAnalyticsEvent("Product Viewed", {
    product_id: offerSku,
    sku: offerSku,
    name: offerName,
    category: offerKind,
    price: offerAmountCents / 100,
    quantity: 1,
    currency,
    value: offerAmountCents / 100,
    offer_kind: offerKind,
    parent_order_id: orderId
  });

  if (viewEventId) {
    const viewEventName = offerKind === "oto" ? "OTO_Viewed" : "Downsell_Viewed";
    trackMeta(viewEventName, viewEventId, {
      content_type: "product",
      content_ids: [offerSku],
      content_name: offerName,
      value: offerAmountCents / 100,
      order_id: orderId
    });
  }

  const showStatus = (message: string, tone: "" | "error" | "success" = "") => {
    if (!status) {
      return;
    }

    status.hidden = false;
    status.className = tone ? `status-banner ${tone}` : "status-banner";
    status.textContent = message;
  };

  const setBusy = (busy: boolean) => {
    acceptButton?.toggleAttribute("disabled", busy);
    declineButton?.toggleAttribute("disabled", busy);
  };

  const fireDecisionPixel = (type: "accept" | "decline", payload: OfferDecisionResponse) => {
    if (!payload.metaEventId) return;
    const action = type === "accept" ? "Accepted" : "Rejected";
    const eventName = offerKind === "oto" ? `OTO_${action}` : `Downsell_${action}`;
    trackMeta(eventName, payload.metaEventId, {
      content_type: "product",
      content_ids: [offerSku],
      content_name: offerName,
      value: offerAmountCents / 100,
      order_id: orderId
    });

    const firePurchase = () => {
      if (!payload.purchaseMetaEventId || typeof payload.purchaseValue !== "number") {
        return;
      }
      const contents = payload.purchaseContents ?? [];
      trackMeta("Purchase", payload.purchaseMetaEventId, {
        // Server returns purchaseCurrency from orders.currency (Stripe-sourced).
        // Fall back to the order's currency exposed via data-currency, never to
        // a hardcoded ISO code that could be wrong for non-USD funnels.
        currency: (payload.purchaseCurrency ?? currency).toLowerCase(),
        value: payload.purchaseValue,
        content_type: "product",
        content_ids: contents.map((c) => c.id),
        contents,
        num_items: payload.purchaseNumItems ?? contents.length,
        order_id: orderId
      });
    };

    if (type === "accept") {
      firePurchase();
    } else if (type === "decline" && offerKind === "downsell") {
      firePurchase();
    }
  };

  const runAction = async (type: "accept" | "decline") => {
    try {
      setBusy(true);
      const actionCopy =
        type === "accept"
          ? offerKind === "oto"
            ? "Adding offer to your order..."
            : "Adding offer to your order..."
          : offerKind === "oto"
            ? "Otwieram alternatywną ofertę…"
            : "Finishing your order...";
      showStatus(actionCopy);

      const response = await fetch(`/api/offers/${token}/${type}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...metaForwardHeaders() }
      });
      const payload = (await response.json().catch(() => ({}))) as OfferDecisionResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Could not process this offer");
      }

      // BLIK / P24: server returned a deferred PaymentIntent for the buyer to
      // confirm via Stripe.js. Don't navigate; trigger the method-specific UI.
      // The offer instance stays in `presented` state until the webhook
      // finalizes it post-confirmation.
      if (type === "accept" && payload.paymentAction) {
        if (payload.paymentAction.method === "blik") {
          showStatus("Opening payment confirmation...");
          openBlikModal(payload.paymentAction.clientSecret);
          return;
        }
        if (payload.paymentAction.method === "p24") {
          showStatus("Przekierowuję do Przelewy24…");
          await triggerP24(payload.paymentAction.clientSecret);
          return;
        }
      }

      fireDecisionPixel(type, payload);

      if (payload.nextStep === "downsell" && payload.nextToken) {
        window.location.assign(`/downsell/${payload.nextToken}`);
        return;
      }

      window.location.assign(`/thank-you/${payload.orderId}`);
    } catch (error) {
      showStatus(
        error instanceof Error ? error.message : "Could not process this offer.",
        "error"
      );
      setBusy(false);
    }
  };

  acceptButton?.addEventListener("click", () => void runAction("accept"));
  declineButton?.addEventListener("click", () => void runAction("decline"));

  const deadline = new Date(expiresAt).getTime();
  const updateTimer = () => {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      if (timer) {
        timer.textContent = "Offer expired. Redirecting...";
      }
      setBusy(true);
      window.setTimeout(() => {
        window.location.assign(`/thank-you/${orderId}`);
      }, 1200);
      return;
    }

    const totalSeconds = Math.floor(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");

    if (timer) {
      timer.textContent = `Offer expires in ${minutes}:${seconds}`;
    }
  };

  updateTimer();
  window.setInterval(updateTimer, 1000);
}
