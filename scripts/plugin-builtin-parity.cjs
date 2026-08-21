#!/usr/bin/env node
"use strict";
/*
 * plugin-builtin-parity — the built-in plugin loader must emit catalog rows that are
 * byte-identical to the hand-written literals it replaced.
 *
 * Why this gate exists: `installFromCatalog` persists `args` verbatim into
 * `mcp_servers.args_json` and only expands `~` at spawn time. A loader that "improves" a
 * launch string would silently rewrite every existing installation's row on the next
 * refreshInstalledCatalogServer — and for the two inline tools it would also cost them
 * their authenticity, i.e. the wrapper-bypass privilege (PLUGIN-SPEC INV-2, INV-4).
 *
 * Run after `npm run build:electron`:
 *   node scripts/plugin-builtin-parity.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const DIST = path.resolve(__dirname, "..", "dist");
if (!fs.existsSync(path.join(DIST, "electron/mcp-tools/catalog.js"))) {
  console.log("SKIP — dist/ not built. Run `npm run build:electron` first.");
  process.exit(0);
}
const { MCP_TOOL_CATALOG } = require(DIST + "/electron/mcp-tools/catalog.js");

// Expected values lifted from git HEAD's catalog.ts (the pre-change literals).
const EXPECTED = {
  "cua-driver": { name: "Agentlas 컴퓨터 유즈", nameEn: "Agentlas Computer Use", category: "web",
    brandColor: "#F97316", mark: "CU", docsUrl: "https://agentlas.cloud/desktop", transport: "stdio" },
  "playwright": { name: "Playwright (브라우저)", nameEn: "Playwright (browser)", category: "web",
    brandColor: "#2EAD33", mark: "PW", docsUrl: "https://github.com/microsoft/playwright-mcp", transport: "stdio" },
  "agentlas-browser": { name: "Agentlas 브라우저 (실제 로그인)", nameEn: "Agentlas Browser (real login)", category: "web",
    brandColor: "#1D7E67", mark: "AB", docsUrl: "https://github.com/microsoft/playwright-mcp", transport: "stdio" },
  "agentlas-time": { name: "시스템 시간", nameEn: "System Time", category: "data",
    brandColor: "#2563EB", mark: "T", transport: "stdio" },
};

let bad = 0;
for (const [id, exp] of Object.entries(EXPECTED)) {
  const row = MCP_TOOL_CATALOG.find((e) => e.id === id);
  if (!row) { console.log(`MISSING ${id}`); bad++; continue; }
  for (const [k, want] of Object.entries(exp)) {
    if (row[k] !== want) { console.log(`DIFF ${id}.${k}: ${JSON.stringify(row[k])} != ${JSON.stringify(want)}`); bad++; }
  }
  if (row.command !== process.execPath) { console.log(`DIFF ${id}.command`); bad++; }
  if (!Array.isArray(row.envRequirements) || row.envRequirements.length) { console.log(`DIFF ${id}.envRequirements`); bad++; }
}
// launch args
const browser = MCP_TOOL_CATALOG.find(e => e.id === "agentlas-browser");
const pw = MCP_TOOL_CATALOG.find(e => e.id === "playwright");
if (JSON.stringify(browser.args) !== JSON.stringify(["~/.agentlas/agentlas-browser-cdp.mjs"])) { console.log("DIFF browser.args", browser.args); bad++; }
if (JSON.stringify(pw.args) !== JSON.stringify(browser.args)) { console.log("DIFF playwright.args != browser.args"); bad++; }
const cua = MCP_TOOL_CATALOG.find(e => e.id === "cua-driver");
const time = MCP_TOOL_CATALOG.find(e => e.id === "agentlas-time");
if (cua.args[0] !== "-e" || cua.args.length !== 3) { console.log("DIFF cua.args shape", cua.args.slice(0,1), cua.args.length); bad++; }
if (time.args[0] !== "-e") { console.log("DIFF time.args shape"); bad++; }

// authenticity must still hold — this is the wrapper-bypass privilege (INV-2/INV-4)
const { isAuthenticComputerUseMcpLaunch } = require(DIST + "/electron/computer-use/mcp-server.js");
const { isAuthenticSystemTimeMcpLaunch } = require(DIST + "/electron/mcp-tools/system-time-server.js");
if (!isAuthenticComputerUseMcpLaunch(cua.command, cua.args)) { console.log("FAIL cua-driver is NOT authentic — wrapper-bypass privilege lost"); bad++; }
if (!isAuthenticSystemTimeMcpLaunch(time.command, time.args)) { console.log("FAIL agentlas-time is NOT authentic"); bad++; }

console.log(bad ? `\n${bad} parity violation(s)` : "\nparity OK — all 4 rows byte-identical, both inline tools still authentic");
process.exit(bad ? 1 : 0);
