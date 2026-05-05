import {
  captureAnalyticsEvent,
  identifyAnalytics,
  initFunnelAnalytics,
  readAnonymousId,
  wireScrollTracking
} from "./analytics";
import { trackMeta } from "./meta-pixel";

const config = document.querySelector<HTMLElement>('[data-page-config="thank-you"]');

if (config) {
  const orderId = config.dataset.orderId ?? "";
  const anonymousId = config.dataset.anonymousId || readAnonymousId();

  initFunnelAnalytics({
    posthogKey: config.dataset.posthogKey ?? "",
    apiHost: config.dataset.apiHost ?? "",
    metaPixelId: config.dataset.metaPixelId ?? "",
    anonymousId,
    superProperties: orderId ? { order_id: orderId } : undefined
  });

  // Stay on the same PostHog person from arrival → purchase. Attach order_id
  // as a person property; do NOT rotate distinct_id to `order:<id>`.
  if (orderId) {
    identifyAnalytics(anonymousId, { order_id: orderId });
  }

  wireScrollTracking();

  const purchaseEventId = config.dataset.purchaseEventId ?? "";
  const purchaseValueRaw = config.dataset.purchaseValue ?? "";
  const purchaseCurrency = (config.dataset.purchaseCurrency ?? "").toLowerCase();
  const purchaseContentsRaw = config.dataset.purchaseContents ?? "";
  const purchaseNumItemsRaw = config.dataset.purchaseNumItems ?? "";

  if (purchaseEventId && purchaseValueRaw && purchaseCurrency) {
    let contents: Array<{ id: string; quantity: number; item_price: number }> = [];
    if (purchaseContentsRaw) {
      try {
        contents = JSON.parse(purchaseContentsRaw);
      } catch {
        contents = [];
      }
    }
    const numItems = purchaseNumItemsRaw ? Number(purchaseNumItemsRaw) : contents.length;

    trackMeta("Purchase", purchaseEventId, {
      currency: purchaseCurrency,
      value: Number(purchaseValueRaw),
      content_type: "product",
      content_ids: contents.map((c) => c.id),
      contents,
      num_items: numItems,
      order_id: orderId
    });
  }

  // Browser-fired sibling of the server's `Order Completed`. Carries full
  // PostHog session enrichment ($host, $session_entry_*, $current_url, utm_*).
  // Use this event for variant/attribution analytics; revenue stays sourced
  // from the server's `Order Completed`. $insert_id keys to the order so a
  // page refresh dedupes server-side in PostHog ingestion.
  const orderConfirmedRaw = config.dataset.orderConfirmed ?? "";
  if (orderConfirmedRaw && orderId) {
    try {
      const payload = JSON.parse(orderConfirmedRaw) as {
        order_id: string;
        total: number;
        revenue: number;
        currency: string;
        products: Array<{
          product_id: string;
          sku: string;
          name: string;
          category: string;
          price: number;
          quantity: number;
        }>;
      };
      captureAnalyticsEvent("Order Confirmed", {
        ...payload,
        $insert_id: `order-confirmed:${payload.order_id}`,
        app_source: "astro_native_browser"
      });
    } catch {
      // Malformed JSON — skip silently. Server-side Order Completed still fires.
    }
  }
}
