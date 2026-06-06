"use strict";
/*
 * native-host: claude / codex / gemini 를 headless 스트리밍으로 구동하고
 * 그 이벤트를 agentlas TUI 안에서 렌더한다. (사용자 결정: "agentlas 터미널이 항상 호스트")
 *
 * 핵심: 사용자의 기존 claude/codex 구독 인증을 그대로 사용한다 (API 키 불필요).
 *  - claude:  claude -p <prompt> --output-format stream-json --include-partial-messages --verbose
 *             (멀티턴은 --resume <session_id>)
 *  - codex:   codex exec --json --skip-git-repo-check -C <cwd> [sandbox] <prompt>
 *             (멀티턴은 codex exec resume <thread_id> ...)
 *  - gemini:  gemini -p <system+prompt> [--yolo]  (stdout 평문 스트리밍)
 *
 * 스키마는 실측으로 확인됨 (cli/agentlas.cjs 상단 주석 참고).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

function cliMcpConfigPath() {
  const dir = path.join(userDataDir(), "mcp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "agentlas-cli-mcp.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
    }, null, 2),
    "utf8",
  );
  return file;
}

const CODEX_PLAYWRIGHT_MCP_ARGS = [
  "-c", 'mcp_servers.playwright.command="npx"',
  "-c", 'mcp_servers.playwright.args=["-y","@playwright/mcp@latest"]',
];

// 툴 input(JSON)에서 사람이 읽을 대표 인자 한 줄 추출.
function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  const pick = (k) => (typeof input[k] === "string" ? input[k] : undefined);
  return (
    pick("file_path") ||
    pick("path") ||
    pick("command") ||
    pick("pattern") ||
    pick("query") ||
    pick("url") ||
    pick("notebook_path") ||
    (pick("prompt") ? pick("prompt").slice(0, 80) : "") ||
    ""
  );
}

// child.stdout → 줄 단위 콜백. 종료 시 잔여 버퍼 flush.
function lineReader(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf);
  });
}

// ── claude-code ──────────────────────────────────────────
function claudeArgs({ prompt, systemPrompt, permission, session }) {
  const perm =
    permission === "full"
      ? ["--permission-mode", "bypassPermissions"]
      : permission === "write"
        ? ["--permission-mode", "acceptEdits"]
        : [];
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    ...perm,
  ];
  if (permission === "write" || permission === "full") {
    args.push("--mcp-config", cliMcpConfigPath(), "--allowedTools", "mcp__playwright");
  }
  if (session && session.id) {
    args.push("--resume", session.id);
  } else if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}

function handleClaudeLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  switch (obj.type) {
    case "system":
      if (obj.subtype === "init" && obj.session_id) st.session.id = obj.session_id;
      // hook_started / hook_response / status → 노이즈, 무시
      return;
    case "stream_event": {
      const ev = obj.event || {};
      if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        if (cb.type === "tool_use") {
          st.tools[ev.index] = { name: cb.name || "tool", input: "" };
          ui.tool(prettyToolName(cb.name), "");
        } else if (cb.type === "text") {
          ui.streamStart();
        }
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta || {};
        if (d.type === "text_delta" && d.text) {
          ui.streamDelta(d.text);
          st.text += d.text;
        } else if (d.type === "input_json_delta" && st.tools[ev.index]) {
          st.tools[ev.index].input += d.partial_json || "";
        }
      } else if (ev.type === "content_block_stop") {
        const t = st.tools[ev.index];
        if (t) {
          let parsed;
          try {
            parsed = JSON.parse(t.input || "{}");
          } catch {
            parsed = null;
          }
          const arg = summarizeToolInput(t.name, parsed);
          if (arg) ui.info(ui.c.dim("  " + arg));
        } else {
          ui.streamEnd();
        }
      }
      return;
    }
    case "user": {
      // tool_result 들
      const content = obj.message && obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const txt = Array.isArray(block.content)
              ? block.content.map((b) => (b.type === "text" ? b.text : "")).join("")
              : typeof block.content === "string"
                ? block.content
                : "";
            ui.toolResult(txt, !block.is_error);
          }
        }
      }
      return;
    }
    case "result":
      st.finalText = typeof obj.result === "string" ? obj.result : st.text;
      st.usage = {
        input_tokens: obj.usage && obj.usage.input_tokens,
        output_tokens: obj.usage && obj.usage.output_tokens,
        cost_usd: obj.total_cost_usd,
        duration_ms: obj.duration_ms,
      };
      if (obj.is_error) st.error = obj.result || "claude error";
      return;
    case "rate_limit_event":
      if (obj.rate_limit_info && obj.rate_limit_info.status === "rejected") {
        ui.warn("claude rate limit reached");
      }
      return;
    default:
      return;
  }
}

function prettyToolName(name) {
  return name || "tool";
}

// ── codex ────────────────────────────────────────────────
function codexArgs({ prompt, systemPrompt, permission, session, cwd }) {
  const sandbox =
    permission === "full" || permission === "write"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--sandbox", "read-only", "--ask-for-approval", "never"];
  const mcp = permission === "write" || permission === "full" ? CODEX_PLAYWRIGHT_MCP_ARGS : [];
  const full = systemPrompt && !(session && session.id) ? `[SYSTEM]\n${systemPrompt}\n\n${prompt}` : prompt;
  // -C/--sandbox/--skip-git-repo-check 는 `codex exec` 옵션이라 `resume <id>` 토큰 *앞에* 와야 한다.
  // (codex-cli 0.133: resume 뒤에 두면 `unexpected argument` 로 거부 → 멀티턴 전부 실패. 실측 검증됨.)
  const base = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, ...sandbox, ...mcp];
  if (session && session.id) {
    return [...base, "resume", session.id, full];
  }
  return [...base, full];
}

function handleCodexLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  switch (obj.type) {
    case "thread.started":
      if (obj.thread_id) st.session.id = obj.thread_id;
      return;
    case "turn.started":
      ui.status("thinking…");
      return;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = obj.item || {};
      const done = obj.type === "item.completed";
      renderCodexItem(item, done, st, ui);
      return;
    }
    case "turn.completed":
      if (obj.usage) {
        st.usage = {
          input_tokens: obj.usage.input_tokens,
          output_tokens: obj.usage.output_tokens,
        };
      }
      st.finalText = st.text;
      return;
    case "turn.failed":
    case "error":
      st.error = (obj.error && (obj.error.message || obj.error)) || "codex error";
      ui.error(String(st.error));
      st.errorShown = true;
      return;
    default:
      return;
  }
}

function renderCodexItem(item, done, st, ui) {
  const type = item.type || "";
  switch (type) {
    case "agent_message": {
      const text = item.text || "";
      // 증분 스트리밍 (item.updated 가 누적 text를 줄 때)
      const prev = st.itemText[item.id] || "";
      if (text.length > prev.length) {
        if (!prev) ui.streamStart();
        const slice = text.slice(prev.length);
        ui.streamDelta(slice);
        st.itemText[item.id] = text;
        st.text += slice; // 누적 — 한 턴에 agent_message item이 여러 개여도 합쳐서 보존
      }
      if (done) ui.streamEnd();
      return;
    }
    case "reasoning": {
      if (done && item.text) {
        ui.line(ui.c.faint("  " + ui.c.italic(truncateLines(item.text, 3))));
      } else {
        ui.status("reasoning…");
      }
      return;
    }
    case "command_execution":
    case "command": {
      if (!st.itemSeen[item.id]) {
        ui.tool("Bash", item.command || item.cmd || "");
        st.itemSeen[item.id] = true;
      }
      if (done) {
        const out = item.aggregated_output || item.stdout || item.output || "";
        const ok = item.exit_code == null || item.exit_code === 0;
        if (out) ui.toolResult(out, ok);
        else ui.toolResult(ok ? "done" : `exit ${item.exit_code}`, ok);
      }
      return;
    }
    case "file_change":
    case "patch": {
      if (!st.itemSeen[item.id]) {
        const files = item.changes
          ? item.changes.map((c) => c.path).join(", ")
          : item.path || "";
        ui.tool("Edit", files);
        st.itemSeen[item.id] = true;
      }
      if (done && item.diff) ui.toolResult(item.diff, true);
      return;
    }
    case "mcp_tool_call":
    case "tool_call": {
      if (!st.itemSeen[item.id]) {
        ui.tool(item.name || item.tool || "tool", argSummary(item));
        st.itemSeen[item.id] = true;
      }
      if (done && (item.result || item.output)) ui.toolResult(item.result || item.output, true);
      return;
    }
    default:
      // 알 수 없는 item — 우아하게 한 줄.
      if (done && (item.text || item.summary)) {
        ui.info((type || "item") + ": " + truncateLines(item.text || item.summary, 1));
      }
      return;
  }
}

function argSummary(item) {
  try {
    const a = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
    return summarizeToolInput(item.name, a);
  } catch {
    return "";
  }
}
function truncateLines(s, n) {
  const lines = String(s).trim().split("\n").slice(0, n);
  return lines.join(" ").slice(0, 200);
}

// ── gemini (평문 스트리밍 폴백) ───────────────────────────
function geminiArgs({ prompt, systemPrompt, permission }) {
  const yolo = permission === "full" || permission === "write" ? ["--yolo"] : [];
  return ["--prompt", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`, ...yolo];
}

// ── 공통 실행기 ───────────────────────────────────────────
// req = { kind, bin, prompt, systemPrompt, cwd, permission, session, ui, env, signal }
// 반환: Promise<{ text, session, usage, error }>
function runNativeTurn(req) {
  const { kind, bin, ui } = req;
  const cwd = req.cwd;
  const st = {
    text: "",
    finalText: "",
    usage: null,
    error: null,
    session: req.session || {},
    tools: {},
    itemText: {},
    itemSeen: {},
  };

  let args;
  let lineHandler;
  let plainStream = false;
  if (kind === "claude-code") {
    args = claudeArgs(req);
    lineHandler = (l) => handleClaudeLine(l, st, ui);
  } else if (kind === "codex") {
    args = codexArgs({ ...req, cwd });
    lineHandler = (l) => handleCodexLine(l, st, ui);
  } else if (kind === "gemini") {
    args = geminiArgs(req);
    plainStream = true;
  } else {
    return Promise.resolve({ text: "", session: st.session, error: `unknown runtime: ${kind}` });
  }

  return new Promise((resolve) => {
    ui.status(`starting ${kind === "claude-code" ? "claude" : kind}…`);
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: req.env || process.env,
      });
    } catch (e) {
      ui.error(`failed to run ${kind}: ${e.message}`);
      return resolve({ text: "", session: st.session, error: e.message });
    }

    // Ctrl-C → 자식 종료
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (plainStream) {
      let plainStarted = false;
      lineReader(child.stdout, (l) => {
        if (!plainStarted) {
          ui.streamStart();
          plainStarted = true;
        }
        ui.streamDelta(l + "\n");
        st.text += l + "\n";
      });
    } else {
      lineReader(child.stdout, lineHandler);
    }

    let stderrBuf = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderrBuf += d;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.on("error", (err) => {
      ui.stopSpinner();
      ui.error(`failed to run ${kind}: ${err.message}`);
      resolve({ text: "", session: st.session, error: err.message });
    });
    child.on("close", (code) => {
      if (req.signal) req.signal.removeEventListener?.("abort", onAbort);
      ui.streamEnd();
      ui.stopSpinner();
      const text = (st.finalText || st.text || "").trim();
      const aborted = req.signal && req.signal.aborted;
      if (st.error && !st.errorShown) {
        // claude `result` is_error 등 — 이전에 표시되지 않은 에러를 노출
        ui.error(String(st.error));
      } else if (code !== 0 && !text && !aborted) {
        ui.error(`${kind} exited with code ${code}` + (stderrBuf.trim() ? `\n${stderrBuf.trim().slice(-500)}` : ""));
      } else if (!text && !st.error && !aborted) {
        // 정상 종료인데 출력이 비어 있음(거부/차단 등) — 무음 실패 방지
        ui.warn(`${kind}: no output` + (stderrBuf.trim() ? ` (${stderrBuf.trim().slice(-200)})` : ""));
      }
      if (st.usage) ui.cost(st.usage);
      resolve({ text, session: st.session, usage: st.usage, error: st.error });
    });
  });
}

module.exports = { runNativeTurn, summarizeToolInput, claudeArgs, codexArgs };
