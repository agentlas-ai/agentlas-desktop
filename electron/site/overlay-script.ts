// Selection overlay injected into every site design preview document.
//
// Runs inside a sandbox="allow-scripts" iframe (opaque origin — no access to
// the host), and speaks only nonce-enveloped postMessage. The payload shape is
// adapted from Orca's MIT-licensed browser-grab contract
// (github.com/stablyai/orca, src/main/browser/grab-guest-script.ts) with the
// fiber/_debugSource source mapping deliberately dropped: element→source
// mapping here is the injected data-agentlas-id attribute.
import { SITE_GRAB_BUDGET, SITE_MESSAGE_KEY } from "../../shared/site-studio";

/**
 * Build the overlay IIFE. `nonce` scopes the postMessage channel for one
 * render; the host ignores messages carrying any other nonce.
 */
export function buildSiteOverlayScript(nonce: string): string {
  const safeNonce = JSON.stringify(nonce);
  return `(function () {
  "use strict";
  if (window.__agentlasSiteOverlay) return;
  var NONCE = ${safeNonce};
  var KEY = ${JSON.stringify(SITE_MESSAGE_KEY)};
  var BUDGET = ${JSON.stringify(SITE_GRAB_BUDGET)};
  var mode = "browse";
  var overlayVisible = true;
  var selectedEl = null;

  function post(message) {
    try {
      var envelope = {};
      envelope[KEY] = NONCE;
      envelope.message = message;
      window.parent.postMessage(envelope, "*");
    } catch (err) { /* host gone — nothing to do */ }
  }

  function clamp(value, max) {
    value = String(value == null ? "" : value);
    return value.length > max ? value.slice(0, max) + "\\u2026" : value;
  }

  // --- overlay chrome (pointer-events: none, so it never eats clicks) -----
  function makeBox(color, dashed) {
    var el = document.createElement("div");
    el.setAttribute("data-agentlas-overlay-ui", "1");
    el.style.cssText =
      "position:fixed;z-index:2147483646;pointer-events:none;display:none;" +
      "border:2px " + (dashed ? "dashed" : "solid") + " " + color + ";" +
      "border-radius:3px;box-sizing:border-box;";
    return el;
  }
  var hoverBox = makeBox("#38bdf8", true);
  var selectBox = makeBox("#0ea5e9", false);
  var label = document.createElement("div");
  label.setAttribute("data-agentlas-overlay-ui", "1");
  label.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
    "background:#0ea5e9;color:#fff;font:11px/1.6 -apple-system,sans-serif;" +
    "padding:0 6px;border-radius:3px;max-width:60vw;overflow:hidden;" +
    "white-space:nowrap;text-overflow:ellipsis;";
  function mount() {
    var root = document.body || document.documentElement;
    root.appendChild(hoverBox);
    root.appendChild(selectBox);
    root.appendChild(label);
  }

  function positionBox(box, rect) {
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = Math.max(rect.width, 2) + "px";
    box.style.height = Math.max(rect.height, 2) + "px";
    box.style.display = overlayVisible ? "block" : "none";
  }

  function describe(el) {
    if (!el || !el.tagName) return null;
    var id = el.getAttribute && el.getAttribute("data-agentlas-id");
    return el.tagName.toLowerCase() + (id ? "[" + id + "]" : "");
  }

  function shortSelector(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.tagName && depth < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) part += "#" + node.id;
      else if (node.classList && node.classList.length) part += "." + node.classList[0];
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return clamp(parts.join(" > "), BUDGET.selector);
  }

  var STYLE_KEYS = ["display","position","width","height","margin","padding","color",
    "backgroundColor","border","borderRadius","fontFamily","fontSize","fontWeight",
    "lineHeight","textAlign","zIndex"];

  function buildPayload(el) {
    var rect = el.getBoundingClientRect();
    var computed = window.getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLE_KEYS.length; i += 1) {
      styles[STYLE_KEYS[i]] = String(computed[STYLE_KEYS[i]] || "");
    }
    var prev = el.previousElementSibling;
    var next = el.nextElementSibling;
    return {
      id: el.getAttribute("data-agentlas-id") || "",
      tagName: el.tagName.toLowerCase(),
      selector: shortSelector(el),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      classes: clamp(el.getAttribute("class") || "", BUDGET.classes),
      textSnippet: clamp((el.textContent || "").replace(/\\s+/g, " ").trim(), BUDGET.textSnippet),
      htmlSnippet: clamp(el.outerHTML, BUDGET.htmlSnippet),
      styles: styles,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      pageRect: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      },
      nearby: {
        parent: describe(el.parentElement),
        prev: describe(prev),
        next: describe(next)
      },
      page: {
        title: document.title || "",
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    };
  }

  function targetFrom(event) {
    var node = event.target;
    while (node && node.getAttribute) {
      if (node.getAttribute("data-agentlas-overlay-ui")) return null;
      if (node.getAttribute("data-agentlas-id")) return node;
      node = node.parentElement;
    }
    return null;
  }

  function refreshSelectedBox() {
    if (!selectedEl || !selectedEl.isConnected) {
      selectBox.style.display = "none";
      return;
    }
    positionBox(selectBox, selectedEl.getBoundingClientRect());
  }

  document.addEventListener("mousemove", function (event) {
    if (mode !== "select") return;
    var el = targetFrom(event);
    if (!el) {
      hoverBox.style.display = "none";
      label.style.display = "none";
      return;
    }
    var rect = el.getBoundingClientRect();
    positionBox(hoverBox, rect);
    label.textContent = el.tagName.toLowerCase() +
      (el.classList && el.classList.length ? "." + el.classList[0] : "");
    label.style.left = rect.left + "px";
    label.style.top = Math.max(rect.top - 20, 2) + "px";
    label.style.display = overlayVisible ? "block" : "none";
  }, true);

  document.addEventListener("click", function (event) {
    if (mode !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    var el = targetFrom(event);
    if (!el) return;
    selectedEl = el;
    refreshSelectedBox();
    hoverBox.style.display = "none";
    post({ type: "select", payload: buildPayload(el) });
  }, true);

  // Block sandbox-escaping interactions while selecting.
  ["mousedown", "mouseup", "dblclick"].forEach(function (name) {
    document.addEventListener(name, function (event) {
      if (mode === "select") { event.preventDefault(); event.stopPropagation(); }
    }, true);
  });

  var scrollTimer = null;
  window.addEventListener("scroll", function () {
    refreshSelectedBox();
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      post({ type: "scroll", x: window.scrollX, y: window.scrollY });
    }, 150);
  }, true);
  window.addEventListener("resize", refreshSelectedBox);

  // --- diagnostics --------------------------------------------------------
  window.addEventListener("error", function (event) {
    post({ type: "pageError", message: clamp(event.message || "unknown", BUDGET.consoleMessage) });
  });
  ["error", "warn"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : null;
    console[level] = function () {
      try {
        var text = Array.prototype.slice.call(arguments).map(function (a) {
          if (typeof a === "string") return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(" ");
        post({ type: "console", level: level, message: clamp(text, BUDGET.consoleMessage) });
      } catch (err) { /* ignore */ }
      if (original) original.apply(null, arguments);
    };
  });

  // --- host commands ------------------------------------------------------
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data[KEY] !== NONCE || !data.message) return;
    var message = data.message;
    if (message.type === "setMode") {
      mode = message.mode === "select" ? "select" : "browse";
      if (mode === "browse") {
        hoverBox.style.display = "none";
        label.style.display = "none";
      }
    } else if (message.type === "restoreScroll") {
      window.scrollTo(message.x || 0, message.y || 0);
    } else if (message.type === "clearSelection") {
      selectedEl = null;
      selectBox.style.display = "none";
    } else if (message.type === "highlight") {
      var el = document.querySelector('[data-agentlas-id="' + message.id + '"]');
      if (el) { selectedEl = el; refreshSelectedBox(); }
    } else if (message.type === "setOverlayVisible") {
      overlayVisible = !!message.visible;
      hoverBox.style.display = "none";
      label.style.display = "none";
      if (!overlayVisible) selectBox.style.display = "none";
      else refreshSelectedBox();
    }
  });

  window.__agentlasSiteOverlay = true;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { mount(); post({ type: "ready" }); });
  } else {
    mount();
    post({ type: "ready" });
  }
})();`;
}
