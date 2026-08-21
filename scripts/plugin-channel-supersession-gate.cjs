#!/usr/bin/env node
"use strict";
/*
 * plugin-channel-supersession-gate — the auto-mode rule that drops a browser tool whose
 * same-capability peer receives a host-injected channel (PLUGIN-SPEC §2.9).
 *
 * Two things are asserted:
 *   1. The mapping is DERIVED from the manifests, not from an id comparison.
 *   2. Removing the channel declaration removes the mapping (mutation test) — otherwise
 *      the rule is a hard-coded `playwright` check wearing a derivation costume.
 *
 * Run after `npm run build:electron`.
 */
const fs = require("node:fs");
const path = require("node:path");
const DIST = path.resolve(__dirname, "..", "dist");
if (!fs.existsSync(path.join(DIST, "electron/plugins/builtin.js"))) {
  console.log("SKIP — dist/ not built. Run `npm run build:electron` first.");
  process.exit(0);
}

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const { channelSupersededTools } = require(DIST + "/electron/plugins/builtin.js");
const map = channelSupersededTools();

check("playwright is superseded by agentlas-browser",
  map.get("playwright") === "agentlas-browser", `got ${map.get("playwright")}`);
check("agentlas-browser is not superseded", !map.has("agentlas-browser"));
check("cua-driver is not superseded (sole tool for its capability)", !map.has("cua-driver"));
check("agentlas-time is not superseded", !map.has("agentlas-time"));
check("nothing else is superseded", map.size === 1, `size=${map.size}`);

// ── the dangerous half: dropping a subset whose superset is not live deletes the capability ──
const { supersededByLivePeer } = require(DIST + "/electron/plugins/builtin.js");
const live = (...ids) => new Set(ids);

check("peer live → playwright is dropped",
  supersededByLivePeer({ toolId: "playwright", pinned: false, liveServerIds: live("agentlas-browser", "playwright") }) === "agentlas-browser");
check("peer NOT installed → playwright survives (capability would otherwise hit zero)",
  supersededByLivePeer({ toolId: "playwright", pinned: false, liveServerIds: live("playwright") }) === null);
check("peer installed but DISABLED → playwright survives",
  supersededByLivePeer({ toolId: "playwright", pinned: false, liveServerIds: live("playwright") }) === null);
check("explicit pin outranks the rule",
  supersededByLivePeer({ toolId: "playwright", pinned: true, liveServerIds: live("agentlas-browser") }) === null);
check("the superset itself is never dropped",
  supersededByLivePeer({ toolId: "agentlas-browser", pinned: false, liveServerIds: live("agentlas-browser") }) === null);
check("an unrelated tool is never dropped",
  supersededByLivePeer({ toolId: "cua-driver", pinned: false, liveServerIds: live("agentlas-browser", "cua-driver") }) === null);

// ── mutation: drop the channel declaration and the mapping must disappear ──
const manifestPath = path.join(DIST, "plugins/agentlas-browser/plugin.json");
const original = fs.readFileSync(manifestPath, "utf8");
try {
  const m = JSON.parse(original);
  for (const t of m.provides.tools) delete t.hostChannels;
  fs.writeFileSync(manifestPath, JSON.stringify(m));
  delete require.cache[require.resolve(DIST + "/electron/plugins/builtin.js")];
  delete require.cache[require.resolve(manifestPath)];
  const { channelSupersededTools: again } = require(DIST + "/electron/plugins/builtin.js");
  check("mutation: with no hostChannels, nothing is superseded", again().size === 0,
    `size=${again().size} — the rule is comparing ids, not reading declarations`);
} finally {
  fs.writeFileSync(manifestPath, original);
}

console.log(failed ? `\n${failed} failure(s)` : "\nchannel supersession OK");
process.exit(failed ? 1 : 0);
