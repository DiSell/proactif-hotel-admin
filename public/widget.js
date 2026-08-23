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

  var widgetUrl = origin + "/widget/" + encodeURIComponent(widgetKey);

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
