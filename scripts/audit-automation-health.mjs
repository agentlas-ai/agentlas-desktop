#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = valueAfter("--db") ?? path.join(os.homedir(), "Library/Application Support/Agentlas/agentlas.sqlite");
const watch = !args.has("--once");
const intervalMs = Number(valueAfter("--interval-ms") ?? 15_000);

const ERROR_PATTERNS = [
  [/##\s*Automation\s+Intervention|type:\s*(tool-choice|login-required|permission-required|credential-required|hub-approval|human-review|workflow-patch)/i, "automation requires user intervention"],
  [/브라우저\s*도구\s*사용\s*불가|browser tools?\s+unavailable/i, "browser tools unavailable"],
  [/haven['’]?t\s+granted|not\s+granted|permission\s+not\s+granted|권한.{0,20}(미승인|없|허용되지)/i, "tool permission not granted"],
  [/Browser\s+is\s+already\s+in\s+use|profile.{0,40}(lock|locked)|프로필.{0,40}(잠김|사용\s*중)|브라우저.{0,40}(잠김|사용\s*중)/i, "browser profile locked"],
  [/blocked\s+by\s+network\s+security|network\s+security|you['’]?ve\s+been\s+blocked/i, "network security blocked the run"],
  [/waiting-for-secure-input|secure-provider-input|credential-vault-input|one-time\s+code|card\s+details/i, "waiting for secure user input"],
  [/파이프라인.{0,60}(무산|실패)|pipeline.{0,60}(failed|aborted)/i, "pipeline failed"],
  [/게시\s*0\s*건[\s\S]{0,160}(무산|실패|사용\s*불가|도구\s*사용\s*불가)/i, "no posts because required tools failed"],
];

const SKIPPED_PATTERNS = [
  [/\bNO_APPROVED\b|\bNO_POSTS_YET\b|no\s+approved|approved\s+drafts?\s*[:=]?\s*0/i, "nothing approved to run"],
  [/승인.{0,30}0\s*개|게시할.{0,30}(없|없음)|처리할.{0,30}(없|없음)/i, "nothing eligible to run"],
  [/nothing\s+to\s+(post|publish|do|process)/i, "nothing eligible to run"],
];

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, commandArgs, opts = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0 && opts.allowFailure !== true) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sqlite(query) {
  if (!fs.existsSync(dbPath)) return [];
  const stdout = run("sqlite3", ["-json", dbPath, query], { allowFailure: true });
  if (!stdout) return [];
  try {
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

function tableColumns(table) {
  return sqlite(`PRAGMA table_info(${table});`).map((row) => row.name).filter(Boolean);
}

function classify(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return { status: "error", reason: "empty assistant result" };
  for (const [re, reason] of ERROR_PATTERNS) if (re.test(normalized)) return { status: "error", reason };
  for (const [re, reason] of SKIPPED_PATTERNS) if (re.test(normalized)) return { status: "skipped", reason };
  return { status: "ok", reason: null };
}

function processLines() {
  const out = run("ps", ["-axo", "pid,ppid,lstart,command"], { allowFailure: true });
  return out.split(/\n/).slice(1).map((line) => line.trim()).filter(Boolean);
}

function inspectProcesses() {
  const lines = processLines();
  const agentlas = lines.filter((line) => /\/Agentlas\.app\/Contents\/MacOS\/Agentlas|ELECTRON_START_URL=http:\/\/localhost:3100|[ /]electron(?:\s|$).*agentlas_desktop/.test(line));
  const renderer = lines.filter((line) => /next dev -p 3100/.test(line));
  const mcp = lines.filter((line) => /playwright-mcp|@playwright\/mcp/.test(line));
  const globalProfile = lines.filter((line) => /--user-data-dir=\/Users\/mason\/\.agentlas\/browser-profile|--user-data-dir \/Users\/mason\/\.agentlas\/browser-profile/.test(line));
  const automationProfiles = lines.filter((line) => /Application Support\/Agentlas\/mcp\/browser-profiles\/automation-/.test(line));
  return { agentlas, renderer, mcp, globalProfile, automationProfiles };
}

function fileHash(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function inspectAppBuilds() {
  const installedAsar = "/Applications/Agentlas.app/Contents/Resources/app.asar";
  const releaseAsar = path.join(repoRoot, "release/mac-arm64/Agentlas.app/Contents/Resources/app.asar");
  const userPatchedAsar = path.join(os.homedir(), "Applications/Agentlas-Patched.app/Contents/Resources/app.asar");
  return {
    installedAsar,
    releaseAsar,
    userPatchedAsar,
    installedHash: fileHash(installedAsar),
    releaseHash: fileHash(releaseAsar),
    userPatchedHash: fileHash(userPatchedAsar),
  };
}

function latestAssistantByAutomation() {
  return sqlite(`
    WITH automation_sessions AS (
      SELECT
        CASE
          WHEN instr(substr(title, length('⟦automation⟧') + 1), '::') > 0
            THEN substr(substr(title, length('⟦automation⟧') + 1), 1, instr(substr(title, length('⟦automation⟧') + 1), '::') - 1)
          ELSE substr(title, length('⟦automation⟧') + 1)
        END AS automation_id,
        id AS chat_id
      FROM chats
      WHERE kind = 'division' AND title LIKE '⟦automation⟧%'
    ),
    ranked AS (
      SELECT
        s.automation_id,
        m.text,
        m.created_at,
        row_number() OVER (PARTITION BY s.automation_id ORDER BY m.created_at DESC) AS rn
      FROM automation_sessions s
      JOIN chat_messages m ON m.chat_id = s.chat_id
      WHERE m.role = 'assistant'
    )
    SELECT automation_id, text, created_at FROM ranked WHERE rn = 1;
  `);
}

function snapshot() {
  const now = new Date();
  const automationCols = tableColumns("automations");
  const hasToolMode = automationCols.includes("tool_mode");
  const hasHubMode = automationCols.includes("hub_mode");
  const automations = sqlite(`
    SELECT
      id,
      name,
      enabled,
      next_run_at,
      last_run_at,
      run_count,
      prompt_template,
      ${hasToolMode ? "tool_mode" : "'auto' AS tool_mode"},
      ${hasHubMode ? "hub_mode" : "'hub-allowed' AS hub_mode"}
    FROM automations
    ORDER BY created_at DESC;
  `);
  const mcpServers = sqlite(`
    SELECT catalog_id, name, enabled
    FROM mcp_servers
    ORDER BY installed_at DESC;
  `);
  const runs = sqlite(`
    SELECT automation_id, status, COALESCE(error, '') AS error, ran_at
    FROM run_history
    ORDER BY ran_at DESC
    LIMIT 12;
  `);
  const latestText = new Map(latestAssistantByAutomation().map((row) => [row.automation_id, row]));
  const processes = inspectProcesses();
  const builds = inspectAppBuilds();
  const findings = [];

  if (processes.agentlas.length === 0) {
    findings.push({ severity: "warn", message: "Agentlas app process not detected. Only DB/process audit is possible until the app is launched." });
  }
  if (
    processes.agentlas.some((line) => line.includes("/Applications/Agentlas.app/Contents/MacOS/Agentlas")) &&
    builds.installedHash &&
    builds.releaseHash &&
    builds.installedHash !== builds.releaseHash
  ) {
    findings.push({
      severity: "error",
      message: "Running /Applications/Agentlas.app differs from the patched release bundle. Restart from ~/Applications/Agentlas-Patched.app or install the new bundle before trusting automation results.",
    });
  }
  if (processes.renderer.length > 0 && processes.agentlas.length === 0) {
    findings.push({ severity: "info", message: "Renderer dev server is running, but no Electron Agentlas app process is detected." });
  }
  if (processes.globalProfile.length > 0) {
    findings.push({ severity: "warn", message: `Global Playwright profile is locked by ${processes.globalProfile.length} process(es). Patched automations use per-automation profiles, but older/manual runs may still fail.` });
  }

  for (const automation of automations) {
    if (!automation.enabled) continue;
    if (
      automation.tool_mode === "auto" &&
      /(reddit|browser|chrome|login|post|instagram|upload|click|브라우저|크롬|로그인|게시|업로드|클릭)/i.test(
        automation.prompt_template ?? "",
      )
    ) {
      findings.push({
        severity: "warn",
        message: `Automation has web/UI wording but no explicit Browser vs Computer Use choice: ${automation.name} (${automation.id})`,
      });
    }
    const next = automation.next_run_at ? Date.parse(automation.next_run_at) : NaN;
    if (Number.isFinite(next) && next <= now.getTime()) {
      findings.push({ severity: "error", message: `Automation is due but not advanced: ${automation.name} (${automation.id}) next=${automation.next_run_at}` });
    }
    const latest = latestText.get(automation.id);
    if (!latest) continue;
    const classified = classify(latest.text);
    const newestRun = runs.find((run) => run.automation_id === automation.id);
    if (classified.status === "error" && newestRun?.status === "ok") {
      findings.push({
        severity: "error",
        message: `False OK candidate: ${automation.name} latest assistant output looks failed (${classified.reason}) but run_history says ok at ${newestRun.ran_at}`,
      });
    }
  }

  return { now: now.toISOString(), automations, runs, mcpServers, processes, builds, findings };
}

function printSnapshot(s) {
  console.log(`\n[agentlas automation audit] ${s.now}`);
  console.log(`DB: ${dbPath}`);
  console.log(`Agentlas processes: ${s.processes.agentlas.length} | dev renderer: ${s.processes.renderer.length} | Playwright MCP: ${s.processes.mcp.length}`);
  console.log(`Global browser profile holders: ${s.processes.globalProfile.length} | automation profile holders: ${s.processes.automationProfiles.length}`);
  const enabledMcp = s.mcpServers.filter((server) => server.enabled === 1);
  console.log(`MCP servers: ${enabledMcp.length}/${s.mcpServers.length} enabled${enabledMcp.length ? ` (${enabledMcp.map((server) => server.catalog_id || server.name).join(", ")})` : ""}`);
  if (s.builds.releaseHash) {
    const installedState =
      s.builds.installedHash && s.builds.installedHash === s.builds.releaseHash
        ? "matches release"
        : s.builds.installedHash
          ? "differs from release"
          : "missing";
    const patchedState =
      s.builds.userPatchedHash && s.builds.userPatchedHash === s.builds.releaseHash
        ? "matches release"
        : s.builds.userPatchedHash
          ? "differs from release"
          : "missing";
    console.log(`Builds: /Applications ${installedState} | ~/Applications/Agentlas-Patched ${patchedState}`);
  }
  console.log("Automations:");
  for (const a of s.automations) {
    console.log(`- ${a.enabled ? "on " : "off"} ${a.name} | tool=${a.tool_mode ?? "auto"} | hub=${a.hub_mode ?? "hub-allowed"} | next=${a.next_run_at ?? "-"} | last=${a.last_run_at ?? "-"} | runs=${a.run_count}`);
  }
  console.log("Recent runs:");
  for (const r of s.runs.slice(0, 6)) {
    console.log(`- ${r.status.padEnd(7)} ${r.automation_id ?? "-"} | ${r.ran_at}${r.error ? ` | ${r.error}` : ""}`);
  }
  if (s.findings.length === 0) {
    console.log("Findings: none");
  } else {
    console.log("Findings:");
    for (const f of s.findings) console.log(`- ${f.severity.toUpperCase()}: ${f.message}`);
  }
}

function runOnce() {
  try {
    printSnapshot(snapshot());
  } catch (err) {
    console.error(`[agentlas automation audit] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

runOnce();
if (watch) {
  setInterval(runOnce, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15_000);
}
