#!/usr/bin/env node
const assert = require("node:assert/strict");
const vm = require("node:vm");

const {
  BROWSER_APPROVAL_CLASSIFIER_SOURCE,
  BROWSER_APPROVAL_CONTEXT_SOURCE,
  browserCdpLauncherSourceForTest,
} = require("../dist/electron/mcp-tools/browser-cdp-launcher.js");

const sandbox = {};
vm.runInNewContext(
  `${BROWSER_APPROVAL_CLASSIFIER_SOURCE}\nglobalThis.__classifyAction = classifyAction;`,
  sandbox,
);
const classify = sandbox.__classifyAction;

vm.runInNewContext(
  `${BROWSER_APPROVAL_CONTEXT_SOURCE}\nglobalThis.__extractCdpPageUrl = extractCdpPageUrl; globalThis.__approvalContextUrl = approvalContextUrl;`,
  sandbox,
);
const extractCdpPageUrl = sandbox.__extractCdpPageUrl;
const approvalContextUrl = sandbox.__approvalContextUrl;

assert.equal(typeof classify, "function");
assert.equal(classify("browser_click", { element: "Pay now" }), "payment");
assert.equal(classify("browser_click", { element: "Publish post" }), "publish");
assert.equal(classify("browser_click", { element: "Delete account" }), "delete");
assert.equal(classify("browser_click", { element: "Send message" }), "send");
assert.equal(
  classify("browser_click", { element: "Continue" }, "https://shop.test/checkout"),
  "payment",
);

// Enter is a submit action even when its arguments contain no intent keyword.
assert.equal(classify("browser_press_key", { key: "Enter" }), "send");
assert.equal(classify("browser_press_key", { key: "Control+Enter" }), "send");
assert.equal(classify("browser_press_key", { key: "ArrowDown" }), null);

assert.equal(
  classify("browser_type", { element: "Comment composer", text: "hello", submit: true }),
  "send",
);
assert.equal(
  classify("browser_type", { element: "Search", text: "hello", submit: false }),
  null,
);
assert.equal(
  classify("browser_type", { element: "Email", text: "a@example.com", submit: true }, "https://shop.test/checkout"),
  "payment",
);

assert.equal(
  classify("browser_fill_form", {
    fields: [{ name: "Credit card number", type: "textbox", value: "secret-ref" }],
  }),
  "payment",
);
// Values are not intent labels: ordinary content can contain action words.
assert.equal(
  classify("browser_fill_form", {
    fields: [{ name: "Draft body", type: "textbox", value: "How to delete old files safely" }],
  }),
  null,
);

assert.equal(classify("browser_handle_dialog", { accept: true }), "send");
assert.equal(classify("browser_run_code_unsafe", { code: "await page.click('button')" }), "unsafe-code");
assert.equal(classify("browser_run_code", { code: "await page.click('button')" }), "unsafe-code");

assert.equal(
  extractCdpPageUrl([
    { type: "page", url: "about:blank" },
    { type: "page", url: "https://evil.example/redirected" },
  ]),
  "https://evil.example/redirected",
);
assert.equal(
  approvalContextUrl("browser_click", { element: "Send" }, "https://evil.example/redirected"),
  "https://evil.example/redirected",
);
assert.equal(
  approvalContextUrl("browser_navigate", { url: "https://target.example/pay" }, "https://old.example"),
  "https://target.example/pay",
);

const launcher = browserCdpLauncherSourceForTest();
assert.ok(launcher.includes(BROWSER_APPROVAL_CLASSIFIER_SOURCE.trim()));
assert.ok(launcher.includes(BROWSER_APPROVAL_CONTEXT_SOURCE.trim()));
assert.ok(!launcher.includes("${BROWSER_APPROVAL_CLASSIFIER_SOURCE}"));
assert.match(launcher, /path: '\/json\/list'/, "approval gate must re-read the live CDP page");
assert.match(launcher, /occupied by a browser not owned/, "foreign CDP ports must be rejected");
assert.match(
  launcher,
  /const trustFallback = autonomy === 'trust' && actionType !== 'payment' && actionType !== 'unsafe-code'/,
  "trust mode must never bypass payment or arbitrary-code checkpoints",
);
assert.doesNotMatch(
  launcher,
  /resolve\(autonomy === 'trust'/,
  "approval transport failures must use the action-aware trust policy",
);

console.log("browser approval classifier passed");
