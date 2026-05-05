import { readAnonymousId } from "./analytics";
import { metaForwardHeaders, trackMeta } from "./meta-pixel";

const LEAD_SESSION_KEY = "lts.lead_session";

type LeadCaptureResponse = {
  leadId: string;
  funnelSessionId: string;
  metaEventIds?: { lead?: string };
};

type StoredLeadSession = {
  leadId: string;
  funnelSessionId: string;
  email: string;
  firstName?: string;
  capturedAt: string;
};

const dialog = document.querySelector<HTMLDialogElement>("#opt-in-dialog");
if (dialog) {
  const form = dialog.querySelector<HTMLFormElement>("#opt-in-popup-form");
  const firstNameInput = dialog.querySelector<HTMLInputElement>("#popupFirstName");
  const emailInput = dialog.querySelector<HTMLInputElement>("#popupEmail");
  const submitButton = dialog.querySelector<HTMLButtonElement>("#opt-in-popup-submit");
  const statusBanner = dialog.querySelector<HTMLDivElement>("#opt-in-popup-status");
  const closeButton = dialog.querySelector<HTMLButtonElement>("#opt-in-popup-close");
  const funnelKey = dialog.dataset.funnelKey ?? "starter-funnel";

  const triggers = document.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>(
    "[data-opt-in-trigger]"
  );

  // Use the canonical reader from analytics.ts so the popup's anonymous_id
  // matches whatever the cookie / middleware / page-checkout already saw. The
  // previous local copy here read only localStorage and could diverge from the
  // cookie that middleware sets on the next request, splitting one buyer into
  // two PostHog persons.
  const getAnonymousId = () => readAnonymousId();

  const hashValue = async (value: string) => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };

  const showStatus = (message: string, tone: "" | "error" | "success" = "") => {
    if (!statusBanner) return;
    statusBanner.hidden = false;
    statusBanner.className = tone ? `status-banner ${tone}` : "status-banner";
    statusBanner.textContent = message;
  };

  const clearStatus = () => {
    if (!statusBanner) return;
    statusBanner.hidden = true;
    statusBanner.textContent = "";
    statusBanner.className = "status-banner";
  };

  const lockBodyScroll = () => {
    document.documentElement.classList.add("opt-in-scroll-locked");
    document.body.classList.add("opt-in-scroll-locked");
  };
  const unlockBodyScroll = () => {
    document.documentElement.classList.remove("opt-in-scroll-locked");
    document.body.classList.remove("opt-in-scroll-locked");
  };

  const openDialog = () => {
    // Pre-fill if we already have a stored session (returning user)
    try {
      const stored = window.sessionStorage.getItem(LEAD_SESSION_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as StoredLeadSession;
        if (firstNameInput && parsed.firstName && !firstNameInput.value) firstNameInput.value = parsed.firstName;
        if (emailInput && parsed.email && !emailInput.value) emailInput.value = parsed.email;
      }
    } catch {
      // ignore parse error
    }

    clearStatus();
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
      lockBodyScroll();
    } else {
      // Fallback for browsers without <dialog> support: graceful nav to /checkout (form fallback there)
      window.location.assign("/checkout");
      return;
    }
    setTimeout(() => firstNameInput?.focus(), 50);
  };

  const closeDialog = () => {
    if (dialog.open) dialog.close();
    submitButton?.removeAttribute("disabled");
  };

  // Always unlock when the dialog actually closes (programmatic, ESC, or backdrop click)
  dialog.addEventListener("close", () => {
    unlockBodyScroll();
  });

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", (event) => {
      // Only intercept primary clicks; allow ctrl/cmd-click & middle-click to fall through to /opt-in
      if (event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1)) {
        return;
      }
      event.preventDefault();
      openDialog();
    });
  });

  closeButton?.addEventListener("click", () => closeDialog());

  // Backdrop click closes the dialog (clicking on the dialog element directly = clicking the backdrop)
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();

    void (async () => {
      const email = emailInput?.value.trim() ?? "";
      const firstName = firstNameInput?.value.trim() || undefined;

      if (!email) {
        showStatus("Wpisz adres e-mail.", "error");
        emailInput?.focus();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showStatus("Sprawdź adres e-mail — wygląda na nieprawidłowy.", "error");
        emailInput?.focus();
        return;
      }

      try {
        submitButton?.setAttribute("disabled", "disabled");
        showStatus("Zapisujemy dane i przygotowujemy płatność...");

        const anonymousId = getAnonymousId();
        const userAgentHash = await hashValue(navigator.userAgent || "unknown");
        const ipHash = await hashValue("client-ip-unavailable");
        const sourcePage = `${window.location.pathname}${window.location.search}`;
        const timestamp = new Date().toISOString();

        const response = await fetch("/api/leads", {
          method: "POST",
          headers: { "content-type": "application/json", ...metaForwardHeaders() },
          body: JSON.stringify({
            identity: {
              email,
              firstName,
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

        const payload = (await response.json().catch(() => ({}))) as LeadCaptureResponse & {
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Could not save your details. Try again.");
        }

        const session: StoredLeadSession = {
          leadId: payload.leadId,
          funnelSessionId: payload.funnelSessionId,
          email,
          firstName,
          capturedAt: timestamp
        };
        try {
          window.sessionStorage.setItem(LEAD_SESSION_KEY, JSON.stringify(session));
        } catch {
          // ignore (private mode)
        }

        if (payload.metaEventIds?.lead) {
          trackMeta("Lead", payload.metaEventIds.lead, {
            content_name: funnelKey,
            funnel_session_id: payload.funnelSessionId
          });
        }

        showStatus("Gotowe! Przechodzimy do płatności...", "success");
        window.location.assign("/checkout");
      } catch (error) {
        showStatus(
          error instanceof Error ? error.message : "Could not save your details. Try again.",
          "error"
        );
        submitButton?.removeAttribute("disabled");
      }
    })();
  });
}
