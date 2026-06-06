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

// MCP 서버 이름 → TOML/JSON 안전 키 (하이픈/공백 → _).
function mcpKey(s) {
  return String((s && (s.name || s.id)) || "mcp").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}
function mcpStdioArgs(s) {
  try { return JSON.parse((s && s.args_json) || "[]"); } catch { return []; }
}
// claude --mcp-config 파일을 쓴다. playwright(항상) + DB에 enabled 된 stdio MCP 서버들.
function cliMcpConfigPath(servers) {
  const dir = path.join(userDataDir(), "mcp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "agentlas-cli-mcp.json");
  const mcpServers = { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } };
  for (const s of servers || []) {
    if (!s || s.enabled === 0 || s.transport !== "stdio" || !s.command) continue;
    mcpServers[mcpKey(s)] = { command: s.command, args: mcpStdioArgs(s) };
  }
  fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), "utf8");
  return { file, names: Object.keys(mcpServers) };
}
// codex -c mcp_servers.<key>.command/args — playwright(항상) + DB stdio 서버들.
function codexMcpArgs(servers) {
  const out = [
    "-c", 'mcp_servers.playwright.command="npx"',
    "-c", 'mcp_servers.playwright.args=["-y","@playwright/mcp@latest"]',
  ];
  for (const s of servers || []) {
    if (!s || s.enabled === 0 || s.transport !== "stdio" || !s.command) continue;
    const k = mcpKey(s);
    out.push("-c", `mcp_servers.${k}.command=${JSON.stringify(s.command)}`);
    out.push("-c", `mcp_servers.${k}.args=${JSON.stringify(mcpStdioArgs(s))}`);
  }
  return out;
}

// 툴 input(JSON)에서 사람이 읽을 대표 인자 한 줄 추출.
function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object") return "";
  // TodoWrite/플랜류 — todos 배열이면 진행 중 항목 또는 개수로 요약.
  if (Array.isArray(input.todos)) {
    const ip = input.todos.find((t) => t && t.status === "in_progress");
    return ip ? String(ip.content || ip.activeForm || "").slice(0, 80) : `${input.todos.length} todos`;
  }
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
function claudeArgs({ prompt, systemPrompt, permission, session, model, effort, mcpServers }) {
  const perm =
    permission === "full"
      ? ["--permission-mode", "bypassPermissions"]
      : permission === "write"
        ? ["--permission-mode", "acceptEdits"]
        : [];
  // /effort → Claude Code는 think 키워드로 reasoning 예산을 올린다(전용 CLI 플래그 없음).
  const thinkKw =
    effort === "max" ? "Ultrathink. " : effort === "high" ? "Think hard. " : effort === "medium" ? "Think. " : "";
  const args = [
    "-p",
    thinkKw + prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    ...perm,
  ];
  if (permission === "write" || permission === "full") {
    const mcpCfg = cliMcpConfigPath(mcpServers);
    args.push("--mcp-config", mcpCfg.file, "--allowedTools", mcpCfg.names.map((n) => "mcp__" + n).join(","));
  }
  if (model) args.push("--model", model); // alias (sonnet/opus) or full id — /model parity
  if (session && session.id) {
    args.push("--resume", session.id);
  } else if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}

// ANSI 제거 (에러 stderr 정리용) — 외부 의존성 없이.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
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
          // 인자가 다 모이는 content_block_stop에서 한 줄로(⏺ Name(arg)) 출력 — Claude Code 스타일
        } else if (cb.type === "thinking") {
          st.think[ev.index] = "";
          ui.status("✻ thinking…");
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
        } else if (d.type === "thinking_delta" && st.think[ev.index] != null) {
          st.think[ev.index] += d.thinking || "";
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
          ui.tool(prettyToolName(t.name), summarizeToolInput(t.name, parsed));
        } else if (st.think[ev.index] != null) {
          const th = String(st.think[ev.index] || "").trim();
          if (th) ui.line(ui.c.faint("  " + ui.c.italic(truncateLines(th, 3))));
          st.think[ev.index] = null;
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
  if (!name) return "tool";
  // mcp__server__tool → server·tool (Claude Code 처럼 깔끔하게)
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `${m[1]}·${m[2]}`;
  return name;
}

// ── codex ────────────────────────────────────────────────
function codexArgs({ prompt, systemPrompt, permission, session, cwd, model, effort, mcpServers }) {
  const sandbox =
    permission === "full" || permission === "write"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : // `codex exec` 는 --ask-for-approval 플래그가 없다(그건 top-level codex 옵션). config 오버라이드로 지정.
        ["--sandbox", "read-only", "-c", 'approval_policy="never"'];
  const mcp = permission === "write" || permission === "full" ? codexMcpArgs(mcpServers) : [];
  const mdl = model ? ["-m", model] : []; // /model parity
  // /effort parity → codex reasoning effort (low|medium|high). max는 high로 매핑.
  const eff = effort ? ["-c", `model_reasoning_effort="${effort === "max" ? "high" : effort}"`] : [];
  const full = systemPrompt && !(session && session.id) ? `[SYSTEM]\n${systemPrompt}\n\n${prompt}` : prompt;
  // -C/--sandbox/--skip-git-repo-check 는 `codex exec` 옵션이라 `resume <id>` 토큰 *앞에* 와야 한다.
  // (codex-cli 0.133: resume 뒤에 두면 `unexpected argument` 로 거부 → 멀티턴 전부 실패. 실측 검증됨.)
  const base = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, ...mdl, ...eff, ...sandbox, ...mcp];
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

// ── gemini (stream-json 구조화 렌더 — claude/codex와 동일 파리티) ──
// gemini-cli는 -o stream-json 으로 init/message(delta)/tool_use/tool_result/result 이벤트를 낸다(실측).
function geminiArgs({ prompt, systemPrompt, permission, model }) {
  // read = 읽기전용(plan), write/full = 자동승인(yolo).
  const approval =
    permission === "full" || permission === "write" ? ["--yolo"] : ["--approval-mode", "plan"];
  const mdl = model ? ["-m", model] : []; // /model parity
  return [
    "--output-format", "stream-json",
    "--skip-trust", // 헤드리스: 이 세션 동안 워크스페이스 신뢰 (untrusted dir exit 55 방지)
    ...approval,
    ...mdl,
    "--prompt", systemPrompt ? `[SYSTEM]\n${systemPrompt}\n\n${prompt}` : prompt,
  ];
}

// gemini 툴명 → 친숙한 표시명 (claude/codex 표기와 통일)
const GEMINI_TOOL_NAMES = {
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  edit: "Edit",
  list_directory: "List",
  glob: "Glob",
  search_file_content: "Grep",
  web_fetch: "Fetch",
  google_web_search: "Search",
  save_memory: "Memory",
};
function prettyGeminiTool(name) {
  return GEMINI_TOOL_NAMES[name] || name || "tool";
}
function handleGeminiLine(line, st, ui) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // 비-JSON 잡음(경고 등) 무시
  }
  switch (obj.type) {
    case "init":
      if (obj.session_id) st.session.id = obj.session_id;
      return;
    case "tool_use": {
      const p = obj.parameters || {};
      const arg = p.command || summarizeToolInput(obj.tool_name, p) || p.description || "";
      if (st.geminiStreaming) {
        ui.streamEnd();
        st.geminiStreaming = false;
      }
      ui.tool(prettyGeminiTool(obj.tool_name), arg);
      return;
    }
    case "tool_result": {
      const out =
        typeof obj.output === "string"
          ? obj.output
          : obj.output != null
            ? JSON.stringify(obj.output)
            : "";
      ui.toolResult(out, obj.status == null || obj.status === "success");
      return;
    }
    case "message": {
      if (obj.role !== "assistant") return; // user echo 스킵
      const txt = typeof obj.content === "string" ? obj.content : "";
      if (!txt) return;
      if (!st.geminiStreaming) {
        ui.streamStart();
        st.geminiStreaming = true;
      }
      ui.streamDelta(txt);
      st.text += txt;
      return;
    }
    case "result": {
      if (st.geminiStreaming) {
        ui.streamEnd();
        st.geminiStreaming = false;
      }
      const s = obj.stats || {};
      st.usage = {
        input_tokens: s.input_tokens,
        output_tokens: s.output_tokens,
        duration_ms: s.duration_ms,
      };
      st.finalText = st.text;
      if (obj.status && obj.status !== "success") st.error = `gemini ${obj.status}`;
      return;
    }
    default:
      return;
  }
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
    think: {},
    geminiStreaming: false,
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
    lineHandler = (l) => handleGeminiLine(l, st, ui);
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
      const errTail = stripAnsi(stderrBuf).replace(/\s+/g, " ").trim(); // ANSI 제거 + 한 줄로
      if (st.error && !st.errorShown) {
        // claude `result` is_error 등 — 이전에 표시되지 않은 에러를 노출
        ui.error(String(st.error));
      } else if (code !== 0 && !text && !aborted) {
        ui.error(`${kind} exited with code ${code}` + (errTail ? `\n  ${errTail.slice(-400)}` : ""));
      } else if (!text && !st.error && !aborted) {
        // 정상 종료인데 출력이 비어 있음(거부/차단 등) — 무음 실패 방지
        ui.warn(`${kind}: no output` + (errTail ? ` (${errTail.slice(-200)})` : ""));
      }
      if (st.usage) ui.cost(st.usage);
      resolve({ text, session: st.session, usage: st.usage, error: st.error });
    });
  });
}

module.exports = { runNativeTurn, summarizeToolInput, claudeArgs, codexArgs };
