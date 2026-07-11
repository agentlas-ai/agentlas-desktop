#!/usr/bin/env node
const assert = require("node:assert/strict");
const vm = require("node:vm");

const {
  BROWSER_APPROVAL_CLASSIFIER_SOURCE,
  BROWSER_APPROVAL_CONTEXT_SOURCE,
  BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE,
  browserCdpCommandFlag,
  browserCdpProcessMatches,
  classifyBrowserCdpOwnership,
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
assert.ok(
  launcher.includes(BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE.trim()),
  "materialized launcher must use the listener-attested ownership runtime",
);
assert.doesNotMatch(launcher, /writeOwner\(child\.pid\)/, "transient launcher pids must never become owner proof");
assert.doesNotMatch(launcher, /child\.once\('exit',[^\n]*clearOwner/, "transient launcher exit must not clear the real owner");
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

const profile = "/Users/qa/Agentlas Profile";
const listener = {
  pid: 4242,
  executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  commandLine: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir="${profile}" --remote-debugging-port=9222 --no-first-run`,
  loopbackOnly: true,
};
assert.equal(browserCdpCommandFlag(listener.commandLine, "user-data-dir"), profile);
assert.equal(browserCdpCommandFlag("chrome --not-user-data-dir=/tmp/evil", "user-data-dir"), null);
assert.equal(
  browserCdpCommandFlag(`${listener.commandLine} --user-data-dir=/tmp/foreign`, "user-data-dir"),
  null,
  "duplicate profile switches must fail closed because Chromium uses the last value",
);
assert.equal(
  browserCdpCommandFlag(`${listener.commandLine} --remote-debugging-port=9333`, "remote-debugging-port"),
  null,
  "duplicate port switches must fail closed",
);
assert.equal(browserCdpProcessMatches(listener, profile, 9222, "darwin"), true);
assert.equal(browserCdpProcessMatches({ ...listener, executable: "/usr/bin/node" }, profile, 9222, "darwin"), false);
assert.equal(browserCdpProcessMatches({ ...listener, executable: "/tmp/Google Chrome" }, profile, 9222, "darwin"), false);
assert.equal(browserCdpProcessMatches({ ...listener, loopbackOnly: false }, profile, 9222, "darwin"), false);
assert.equal(browserCdpProcessMatches({ ...listener, commandLine: `${listener.commandLine} --user-data-dir=/tmp/foreign` }, profile, 9222, "darwin"), false);
assert.equal(browserCdpProcessMatches({ ...listener, commandLine: listener.commandLine.replace("9222", "9223") }, profile, 9222, "darwin"), false);
assert.equal(browserCdpProcessMatches(listener, "/Users/qa/Everyday Chrome", 9222, "darwin"), false);

const linuxProfile = "/home/qa/.agentlas/chrome-cdp-profile";
const linuxListener = {
  pid: 4343,
  executable: "/usr/lib/chromium/chromium",
  commandLine: `/usr/lib/chromium/chromium --user-data-dir=${linuxProfile} --remote-debugging-port=9222`,
  loopbackOnly: true,
};
for (const executable of [
  "/usr/lib/chromium/chromium",
  "/usr/lib/chromium-browser/chromium-browser",
  "/opt/microsoft/msedge/msedge",
  "/snap/chromium/3124/usr/lib/chromium-browser/chrome",
]) {
  assert.equal(
    browserCdpProcessMatches({ ...linuxListener, executable }, linuxProfile, 9222, "linux"),
    true,
    `known Linux post-exec browser path must be accepted: ${executable}`,
  );
}
assert.equal(browserCdpProcessMatches({ ...linuxListener, executable: "/tmp/chromium" }, linuxProfile, 9222, "linux"), false);

assert.deepEqual(
  classifyBrowserCdpOwnership({ processes: [listener], marker: null, profile, port: 9222, platform: "darwin" }),
  { state: "adoptable", pid: 4242, reason: "verified-dedicated-listener" },
  "an exact pre-marker dedicated Chrome must be safely adoptable",
);
assert.deepEqual(
  classifyBrowserCdpOwnership({
    processes: [listener],
    marker: { pid: 4242, port: 9222, profile },
    profile,
    port: 9222,
    platform: "darwin",
  }),
  { state: "owned", pid: 4242, reason: "listener-and-marker-match" },
);
assert.equal(
  classifyBrowserCdpOwnership({
    processes: [listener],
    marker: { pid: 9999, port: 9222, profile },
    profile,
    port: 9222,
    platform: "darwin",
  }).state,
  "adoptable",
  "a stale marker cannot override the attested listener pid",
);
assert.equal(
  classifyBrowserCdpOwnership({ processes: [{ ...listener, executable: "/usr/bin/node" }], marker: null, profile, port: 9222, platform: "darwin" }).state,
  "foreign",
);
assert.equal(
  classifyBrowserCdpOwnership({ processes: [listener, { ...listener, pid: 5252 }], marker: null, profile, port: 9222, platform: "darwin" }).state,
  "foreign",
  "ambiguous listeners must fail closed",
);

const runtimeOwnershipSandbox = {
  fs: require("node:fs"),
  os: require("node:os"),
  path: require("node:path"),
  process: { platform: "darwin", env: {} },
  CDP_PROFILE: profile,
  PORT: 9222,
};
vm.runInNewContext(
  `${BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE}\nglobalThis.__runtimeProcessMatches = processMatches; globalThis.__runtimeClassifyOwnership = classifyOwnership;`,
  runtimeOwnershipSandbox,
);
assert.equal(runtimeOwnershipSandbox.__runtimeProcessMatches(listener), true);
assert.equal(runtimeOwnershipSandbox.__runtimeProcessMatches({ ...listener, executable: "/tmp/Google Chrome" }), false);
assert.equal(
  runtimeOwnershipSandbox.__runtimeProcessMatches({ ...listener, commandLine: `${listener.commandLine} --user-data-dir=/tmp/foreign` }),
  false,
);
assert.equal(
  runtimeOwnershipSandbox.__runtimeClassifyOwnership([listener], null).state,
  "adoptable",
  "materialized launcher must classify the same verified legacy listener as adoptable",
);
assert.equal(
  runtimeOwnershipSandbox.__runtimeClassifyOwnership([{ ...listener, commandLine: listener.commandLine.replace(profile, "/tmp/foreign") }], null).state,
  "foreign",
  "materialized launcher must reject a different profile",
);

const linuxRuntimeSandbox = {
  fs: require("node:fs"),
  os: require("node:os"),
  path: require("node:path"),
  process: { platform: "linux", env: {} },
  CDP_PROFILE: linuxProfile,
  PORT: 9222,
};
vm.runInNewContext(
  `${BROWSER_CDP_OWNERSHIP_RUNTIME_SOURCE}\nglobalThis.__runtimeProcessMatches = processMatches;`,
  linuxRuntimeSandbox,
);
assert.equal(linuxRuntimeSandbox.__runtimeProcessMatches(linuxListener), true);
assert.equal(
  linuxRuntimeSandbox.__runtimeProcessMatches({ ...linuxListener, executable: "/snap/chromium/3124/usr/lib/chromium-browser/chrome" }),
  true,
);
assert.equal(linuxRuntimeSandbox.__runtimeProcessMatches({ ...linuxListener, executable: "/tmp/chromium" }), false);

console.log("browser approval classifier passed");
