import { initFunnelAnalytics, readAnonymousId, wireScrollTracking } from "./analytics";
import "./opt-in-popup";

const config = document.querySelector<HTMLElement>('[data-page-config="home"]');

if (config) {
  const anonymousId = config.dataset.anonymousId || readAnonymousId();
  const funnelKey = config.dataset.funnelKey ?? "starter-funnel";

  initFunnelAnalytics({
    posthogKey: config.dataset.posthogKey ?? "",
    apiHost: config.dataset.apiHost ?? "",
    metaPixelId: config.dataset.metaPixelId ?? "",
    anonymousId,
    superProperties: {
      funnel_key: funnelKey
    }
  });

  wireScrollTracking();
}
