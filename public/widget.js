/**
 * Proactif System — public embed script.
 *
 * <script src="https://DOMAIN/widget.js" data-key="ps_live_xxx"></script>
 *
 * Deliberately tiny and framework-free: creates one floating launcher
 * button and, on first click, one iframe pointing at /widget/[widgetKey]
 * (same origin this script itself was loaded from). All actual chat
 * rendering happens inside that iframe/page — this file never touches the
 * chat API, never receives or renders model output, and never inserts
 * anything into the host page's DOM via innerHTML. The only untrusted-ish
 * value here is the widget key from the host page's own <script> tag,
 * which is only ever used as a URL path segment (encodeURIComponent'd),
 * never as HTML or a script source.
 *
 * HOST-BOOKING BRIDGE — runs on the HOST page (unlike the chat iframe,
 * which is Proactif's own origin), so this is the only place able to
 * trigger the hotel's own booking module already embedded on its site.
 * The bridge is a closed, namespaced postMessage contract with exactly two
 * message shapes, nothing else:
 *   iframe -> here : {type:"proactif:booking"}
 *   here -> iframe  : {type:"proactif:booking-result", status:"triggered"|"unavailable"}
 * No selector, URL, or JS ever travels through either message — the
 * selector lives ONLY in this hotel's own trusted config, fetched
 * independently from the public config endpoint below (never relayed
 * through the iframe). This file never eval()s, never Function()-
 * constructs, never sets innerHTML from any of this — the sole DOM
 * operation is `document.querySelector(selector).click()`, where
 * `selector` is a plain string used exactly as a CSS selector, never
 * executed as code.
 */
(function () {
  "use strict";

  var currentScript = document.currentScript;
  if (!currentScript) return;

  var widgetKey = currentScript.getAttribute("data-key");
  if (!widgetKey) return;

  var origin;
  try {
    origin = new URL(currentScript.src).origin;
  } catch {
    return;
  }

  // The host page's OWN origin — window.location.origin is always exactly
  // an origin (scheme+host+port, no path/query/credentials), so it needs
  // no further validation before being encoded into the iframe URL. The
  // iframe (features/widget/hostOrigin.ts's parseHostOrigin) re-validates
  // it anyway before ever using it as a postMessage targetOrigin — this
  // script is not the trust boundary for that value, the iframe's own
  // parsing is.
  var hostOrigin = window.location.origin;
  var widgetUrl = origin + "/widget/" + encodeURIComponent(widgetKey) + "?hostOrigin=" + encodeURIComponent(hostOrigin);

  // Fetched once, eagerly, so it's ready (or already resolved) by the time
  // a "proactif:booking" message actually arrives — widget.js retrieves
  // this itself rather than trusting anything the iframe might relay,
  // exactly so the postMessage payload never needs to carry configuration.
  var configPromise = fetch(origin + "/api/widget/" + encodeURIComponent(widgetKey) + "/config")
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .catch(function () {
      return null;
    });

  var isOpen = false;
  var iframe = null;

  var bubble = document.createElement("button");
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Ouvrir le chat");
  bubble.textContent = "💬"; // 💬
  bubble.style.cssText = [
    "position:fixed",
    "bottom:16px",
    "right:16px",
    "width:56px",
    "height:56px",
    "border-radius:9999px",
    "border:none",
    "background:#1A1D1A",
    "color:#fff",
    "font-size:24px",
    "line-height:56px",
    "text-align:center",
    "cursor:pointer",
    "box-shadow:0 4px 16px rgba(0,0,0,.22)",
    "z-index:2147483000",
    "padding:0",
  ].join(";");

  function ensureIframe() {
    if (iframe) return iframe;
    iframe = document.createElement("iframe");
    iframe.src = widgetUrl;
    iframe.title = "Assistant de réservation";
    iframe.style.cssText = [
      "position:fixed",
      "bottom:84px",
      "right:16px",
      "width:360px",
      "max-width:calc(100vw - 32px)",
      "height:min(600px, calc(100vh - 120px))",
      "border:none",
      "border-radius:16px",
      "box-shadow:0 12px 40px rgba(0,0,0,.28)",
      "z-index:2147483000",
      "background:#fff",
      "color-scheme:light",
    ].join(";");
    document.body.appendChild(iframe);
    return iframe;
  }

  function openWidget() {
    ensureIframe().style.display = "block";
    bubble.textContent = "✕"; // ✕
    bubble.setAttribute("aria-label", "Fermer le chat");
    isOpen = true;
  }

  function closeWidget() {
    if (iframe) iframe.style.display = "none";
    bubble.textContent = "💬";
    bubble.setAttribute("aria-label", "Ouvrir le chat");
    isOpen = false;
  }

  // Reply to the iframe with the exact, closed result vocabulary — no other
  // status value ever exists. Uses `origin` (Proactif's own origin, already
  // derived from this script's own src) as targetOrigin: the iframe only
  // ever runs at that exact origin, so this is precise, never "*".
  function postResult(status) {
    if (!iframe) return;
    iframe.contentWindow.postMessage({ type: "proactif:booking-result", status: status }, origin);
  }

  function triggerHostBooking() {
    configPromise.then(function (config) {
      if (!config || config.bookingActionMode !== "host_widget" || !config.hostBookingTrigger) {
        postResult("unavailable");
        return;
      }
      var trigger = config.hostBookingTrigger;
      if (trigger.strategy !== "click" || typeof trigger.selector !== "string") {
        postResult("unavailable");
        return;
      }

      var el;
      try {
        // A malformed/legacy selector string must never throw past this
        // point — document.querySelector raises a SyntaxError for an
        // invalid selector, which must degrade to "unavailable", not an
        // uncaught error on the host page.
        el = document.querySelector(trigger.selector);
      } catch {
        el = null;
      }

      if (!el) {
        // Element not found: do NOT close the chat panel, do NOT click
        // anything — nothing on the host page is touched.
        postResult("unavailable");
        return;
      }

      // Only now, once we know there is something real to reveal, reduce
      // the Proactif panel so the host page's own booking module isn't
      // hidden underneath it.
      closeWidget();
      el.click();
      postResult("triggered");
    });
  }

  window.addEventListener("message", function (event) {
    if (!iframe || event.source !== iframe.contentWindow) return;
    if (event.origin !== origin) return;
    if (!event.data || typeof event.data !== "object") return;
    if (event.data.type !== "proactif:booking") return;
    triggerHostBooking();
  });

  bubble.addEventListener("click", function () {
    if (isOpen) {
      closeWidget();
    } else {
      openWidget();
    }
  });

  function mount() {
    document.body.appendChild(bubble);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
