"use strict";
/*
 * agentlas-repl: the interactive shell of the agentlas terminal.
 * agentlas is always the host — when the active runtime is claude/codex/gemini it drives them
 * headless and renders inside this TUI (subscription auth preserved); for BYOK/Ollama it runs
 * its own agent loop (api-agent). agentlas.cjs injects DB helpers via the `helpers` object.
 *
 * First launch runs an onboarding wizard (language → runtime → permission), stored in prefs.
 */
const readline = require("node:readline");
const { Ui } = require("./agentlas-ui.cjs");
const banner = require("./agentlas-banner.cjs");
const { runNativeTurn } = require("./agentlas-native-host.cjs");
const { runApiTurn } = require("./agentlas-api-agent.cjs");
const caps = require("./agentlas-capabilities.cjs");
const input = require("./agentlas-input.cjs");

function runtimeLabel(rt) {
  if (!rt) return "(none)";
  if (rt.mode === "cli") return rt.kind;
  return `${rt.backend}${rt.model ? " · " + rt.model : ""}`;
}

// Hides the trailing "## Memory Events" block from the live stream while keeping the full
// text for curation. Holds back the last heading.length chars so a split heading is safe too.
function makeMemoryGuard(ui, heading) {
  const N = heading.length;
  let acc = "";
  let printed = 0;
  let cut = false;
  const flush = () => {
    if (cut) return;
    const idx = acc.indexOf(heading);
    if (idx >= 0) {
      if (idx > printed) ui.streamDelta(acc.slice(printed, idx));
      printed = idx;
      cut = true;
    } else if (acc.length > printed) {
      ui.streamDelta(acc.slice(printed));
      printed = acc.length;
    }
  };
  return {
    c: ui.c,
    streamStart: () => ui.streamStart(),
    streamDelta: (t) => {
      if (cut) {
        acc += t;
        return;
      }
      acc += t;
      const idx = acc.indexOf(heading);
      if (idx >= 0) {
        if (idx > printed) ui.streamDelta(acc.slice(printed, idx));
        printed = idx;
        cut = true;
        return;
      }
      const safe = acc.length - N;
      if (safe > printed) {
        ui.streamDelta(acc.slice(printed, safe));
        printed = safe;
      }
    },
    streamEnd: () => {
      flush();
      ui.streamEnd();
    },
    tool: (...a) => ui.tool(...a),
    toolResult: (...a) => ui.toolResult(...a),
    info: (...a) => ui.info(...a),
    warn: (...a) => ui.warn(...a),
    error: (...a) => ui.error(...a),
    status: (...a) => ui.status(...a),
    ok: (...a) => ui.ok(...a),
    cost: (...a) => ui.cost(...a),
    line: (...a) => ui.line(...a),
  };
}

// startRepl({ db, subject|null, runtime, permission, cwd, helpers, prefs, savePrefs })
function startRepl(opts) {
  const { db } = opts;
  const H = opts.helpers;
  const prefs = opts.prefs || {};
  prefs.agentRuntime = prefs.agentRuntime || {}; // { agentSlug|firmSlug: runtimeSpec|"auto" }
  let baseRuntime = opts.runtime; // session default; per-agent runtime auto-routes from this
  const ui = new Ui({ lang: prefs.lang || "en" });
  const state = {
    subject: opts.subject || null,
    runtime: opts.runtime,
    permission: opts.permission || "write",
    cwd: opts.cwd,
    history: [],
    native: {}, // kind → { id }
    projectPath: opts.projectPath || null,
    routePreambleOnce: null,
    cost: {}, // runtimeLabel → { turns, in, out, cost, ms } — session usage ledger
  };

  function showBanner() {
    banner.renderBanner({
      ui,
      version: opts.version,
      runtimeLabel: runtimeLabel(state.runtime),
      subjectLabel: state.subject ? state.subject.label : null,
      permission: state.permission,
      cwd: state.cwd,
    });
  }

  const completer = input.makeCompleter({
    getAgentSlugs: () => { try { return H.listAgents(db).map((a) => a.slug); } catch { return []; } },
    getFirmSlugs: () => { try { return H.listFirms(db).map((f) => f.slug); } catch { return []; } },
    getCwd: () => state.cwd,
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, completer, historySize: input.HISTORY_MAX });
  input.attachHistory(rl);
  let busy = false;
  let closed = false;
  let currentAbort = null;
  rl.on("close", () => {
    closed = true;
    if (!busy) process.exit(0);
  });
  rl.on("SIGINT", () => {
    if (busy && currentAbort) {
      currentAbort.abort();
      ui.warn(ui.t("interrupted"));
    } else {
      ui.line("");
      ui.line(ui.c.emerald("🦖 ") + ui.c.dim(ui.t("bye")));
      rl.close();
      process.exit(0);
    }
  });

  function ctxNow() {
    return { projectPath: state.projectPath, agentId: state.subject && state.subject.id, permission: state.permission, cwd: state.cwd, lang: ui.lang };
  }

  // Session usage ledger — accumulate per runtime label (host advantage: no single-model CLI can show this).
  function recordCost(label, usage) {
    const e = state.cost[label] || (state.cost[label] = { turns: 0, in: 0, out: 0, cost: 0, ms: 0 });
    e.turns += 1;
    if (usage) {
      if (usage.input_tokens) e.in += usage.input_tokens;
      if (usage.output_tokens) e.out += usage.output_tokens;
      if (usage.cost_usd) e.cost += usage.cost_usd;
      if (usage.duration_ms) e.ms += usage.duration_ms;
    }
  }

  // ── run one turn ──
  async function runTurn(prompt) {
    busy = true;
    currentAbort = new AbortController();
    const signal = currentAbort.signal;
    const ctx = ctxNow();
    const rt = state.runtime;
    const costLabel = runtimeLabel(rt);
    const runEnv = H.buildChildEnv ? await H.buildChildEnv(db, { ...ctx, cwd: state.cwd }) : process.env;
    Object.assign(process.env, runEnv);
    ui._lastUsage = null;
    try {
      if (rt.mode === "cli") {
        const bin = H.which(H.RUNTIME_BIN[rt.kind]) || H.RUNTIME_BIN[rt.kind];
        const session = state.native[rt.kind] || (state.native[rt.kind] = {});
        const subjectSystem = state.routePreambleOnce
          ? `${state.routePreambleOnce}\n\n${state.subject.system}`
          : state.subject.system;
        state.routePreambleOnce = null;
        const sys = H.augmentSystem(db, subjectSystem, ctx, false);
        const res = await runNativeTurn({
          kind: rt.kind,
          bin,
          prompt,
          systemPrompt: session.id ? "" : sys,
          cwd: state.cwd,
          permission: state.permission,
          session,
          env: runEnv,
          ui,
          signal,
        });
        const at = (res.text || "").trim();
        if (at && !res.error) state.history.push({ role: "user", text: prompt }, { role: "assistant", text: at });
        recordCost(costLabel, res.usage);
      } else {
        const subjectSystem = state.routePreambleOnce
          ? `${state.routePreambleOnce}\n\n${state.subject.system}`
          : state.subject.system;
        state.routePreambleOnce = null;
        const sys = H.augmentSystem(db, subjectSystem, ctx, true);
        let apiKey = null;
        if (rt.backend !== "ollama") {
          apiKey = await H.apiKey(rt.backend);
          if (!apiKey) {
            ui.error(ui.t("noKey", rt.backend));
            return;
          }
        }
        const messages = state.history
          .filter((h) => h.text && h.text.trim())
          .map((h) => ({ role: h.role, content: h.text }))
          .concat([{ role: "user", content: prompt }]);
        const guard = makeMemoryGuard(ui, H.eventsHeading());
        const res = await runApiTurn({
          backend: rt.backend,
          model: rt.model || H.defaultApiModel(rt.backend),
          apiKey,
          system: sys,
          messages,
          ctx,
          ui: guard,
          signal,
        });
        const cleaned = (H.curateCliReply(db, res.text || "", ctx) || "").trim();
        if (cleaned) state.history.push({ role: "user", text: prompt }, { role: "assistant", text: cleaned });
        recordCost(costLabel, ui._lastUsage);
      }
    } catch (e) {
      ui.stopSpinner();
      if (signal.aborted) {
        // user Ctrl-C — SIGINT handler already printed
      } else if (e && e.name === "AbortError") {
        ui.warn(ui.t("stalled"));
      } else {
        ui.error((e && e.message) || String(e));
      }
    } finally {
      busy = false;
      currentAbort = null;
    }
  }

  // ── slash commands ──
  function setRuntime(arg) {
    const cliKinds = { "claude-code": 1, claude: 1, codex: 1, gemini: 1 };
    const apiBackends = { anthropic: 1, openai: 1, google: 1, ollama: 1, upstage: 1 };
    let a = (arg || "").trim();
    if (a === "claude") a = "claude-code";
    if (cliKinds[a]) {
      const bin = H.which(H.RUNTIME_BIN[a]);
      if (!bin) return ui.error(ui.t("runtimeNotInstalled", a));
      state.runtime = { mode: "cli", kind: a };
      state.native = {};
      return ui.ok(ui.t("runtimeSet", a));
    }
    if (apiBackends[a]) {
      state.runtime =
        a === "ollama"
          ? { mode: "api", backend: "ollama", model: state.runtime.backend === "ollama" ? state.runtime.model : null }
          : { mode: "api", backend: a, model: null };
      return ui.ok(ui.t("runtimeSet", runtimeLabel(state.runtime)));
    }
    ui.warn(ui.t("runtimeUsage"));
  }

  // Show the English name when the chosen language is English (agents carry name_en).
  function displayName(a) {
    if (!a) return "";
    if (ui.lang === "en" && a.name_en && a.name_en !== a.name) return a.name_en;
    return a.name || a.name_en || "";
  }
  function installedKinds() {
    return caps.CLI_KINDS.filter((k) => H.which(H.RUNTIME_BIN[k]));
  }
  // Resolve the runtime a subject runs on: pinned (prefs) > capability auto-route > session default.
  function applyRuntimeFor(subject) {
    const pinned = prefs.agentRuntime[subject.slug];
    let spec;
    if (pinned && pinned !== "auto") spec = pinned;
    else spec = caps.autoRuntimeFor(subject.capAgent, { installedKinds: installedKinds(), activeSpec: caps.specOf(baseRuntime) });
    state.runtime = caps.runtimeFromSpec(spec);
    state.native = {};
  }
  // Tell the user when we routed to an image-capable runtime, or when the current one can't make images.
  function routingNote(subject) {
    if (!subject || !caps.needsImage(subject.capAgent)) return;
    const spec = caps.specOf(state.runtime);
    if (caps.capsFor(spec).image) {
      if (spec !== caps.specOf(baseRuntime)) ui.info(ui.t("routedImage", spec));
    } else {
      ui.warn(ui.t("guard.imageWarn", caps.capsFor(spec).label || spec));
    }
  }
  function specToRuntime(spec) {
    return (!spec || spec === "auto") ? null : caps.runtimeFromSpec(spec);
  }

  function setSubjectAgent(agent) {
    state.subject = {
      kind: "agent",
      id: agent.id,
      slug: agent.slug,
      label: displayName(agent),
      system: agent.system_prompt || `You are ${agent.name}.`,
      capAgent: agent,
    };
    state.history = [];
    state.routePreambleOnce = null;
    applyRuntimeFor(state.subject);
  }
  function setSubjectFirm(firm) {
    const sys = H.firmSystemPrompt(db, firm);
    state.subject = {
      kind: "firm",
      id: firm.ceo_agent_id,
      slug: firm.slug,
      label: displayName(firm) + " CEO",
      system: sys,
      capAgent: { name: firm.name, name_en: firm.name_en || firm.name, tagline: firm.tagline, system_prompt: sys },
    };
    state.history = [];
    state.routePreambleOnce = null;
    applyRuntimeFor(state.subject);
  }
  function switchSubject(kind, query) {
    if (kind === "agent") {
      const agent = H.resolveAgent(db, query);
      if (!agent) return ui.error(ui.t("noAgent", query));
      setSubjectAgent(agent);
    } else {
      const firm = H.resolveFirm(db, query);
      if (!firm) return ui.error(ui.t("noCompany", query));
      setSubjectFirm(firm);
    }
    ui.ok(ui.t("switched", state.subject.label));
    routingNote(state.subject);
  }
  // resolved runtime spec for any agent row (for display in roster / team)
  function resolvedSpec(agentRow, slug) {
    const pinned = prefs.agentRuntime[slug];
    if (pinned && pinned !== "auto") return pinned;
    return caps.autoRuntimeFor(agentRow, { installedKinds: installedKinds(), activeSpec: caps.specOf(baseRuntime) });
  }

  function printRoster() {
    const ags = H.listAgents(db);
    const firms = H.listFirms(db);
    ui.line("");
    ui.line(ui.c.dim("  " + ui.t("picker.agents")));
    ags.forEach((a, i) => {
      const spec = resolvedSpec(a, a.slug);
      const bdg = caps.needsImage(a) ? (caps.capsFor(spec).image ? "🖼" : "🖼⚠") : "";
      ui.line(
        "   " + ui.c.faint(String(i + 1).padStart(2)) + "  " + ui.c.emerald(a.slug.padEnd(26)) + " " +
          ui.c.text((displayName(a) || "").padEnd(16)) + " " + ui.c.blue(spec) + (bdg ? " " + bdg : ""),
      );
    });
    if (firms.length) {
      ui.line(ui.c.dim("  " + ui.t("picker.companies")));
      firms.forEach((f) =>
        ui.line("       " + ui.c.emerald(("firm " + f.slug).padEnd(26)) + " " + ui.c.text(displayName(f)) + ui.c.dim(" (CEO)")),
      );
    }
    if (!ags.length && !firms.length) ui.line("   " + ui.c.dim(ui.t("picker.none")));
  }

  // /team — show or assign each agent's runtime (LLM). Auto-routed by capability unless pinned.
  function printTeam() {
    const ags = H.listAgents(db);
    ui.line("");
    ui.line(ui.c.dim("  " + ui.t("team.title")));
    for (const a of ags) {
      const pinned = prefs.agentRuntime[a.slug] && prefs.agentRuntime[a.slug] !== "auto";
      const spec = resolvedSpec(a, a.slug);
      const bdg = caps.needsImage(a) ? (caps.capsFor(spec).image ? "🖼" : "🖼⚠") : "";
      ui.line(
        "   " + ui.c.emerald(a.slug.padEnd(28)) + ui.c.blue((spec + (bdg ? " " + bdg : "")).padEnd(14)) +
          ui.c.faint(pinned ? ui.t("team.pinned") : ui.t("team.auto")),
      );
    }
    ui.line("   " + ui.c.faint(ui.t("team.usage")));
  }
  function setTeam(arg) {
    const parts = arg.trim().split(/\s+/);
    const who = parts[0];
    let spec = (parts[1] || "").trim();
    if (spec === "claude") spec = "claude-code";
    const agent = H.resolveAgent(db, who);
    const firm = agent ? null : H.resolveFirm(db, who);
    const slug = agent ? agent.slug : firm ? firm.slug : null;
    if (!slug) return ui.error(ui.t("noAgent", who));
    if (!spec) return printTeam();
    const valid = ["auto", "claude-code", "codex", "gemini", "anthropic", "openai", "google", "ollama", "upstage"];
    if (!valid.includes(spec)) return ui.warn(ui.t("team.usage"));
    prefs.agentRuntime[slug] = spec;
    if (opts.savePrefs) opts.savePrefs(prefs);
    ui.ok(ui.t("team.set", slug, spec === "auto" ? ui.t("team.auto") : spec));
    if (state.subject && state.subject.slug === slug) {
      applyRuntimeFor(state.subject);
      routingNote(state.subject);
    }
  }

  function printCost() {
    const labels = Object.keys(state.cost);
    ui.line("");
    if (!labels.length) return ui.info(ui.t("noCost"));
    ui.line(ui.c.dim("  " + ui.t("cost.title")));
    let tIn = 0, tOut = 0, tCost = 0, tMs = 0, tTurns = 0;
    const fmt = (e) => {
      const bits = [e.turns + (e.turns === 1 ? " turn" : " turns")];
      if (e.in || e.out) bits.push(e.in + "→" + e.out + " tok");
      if (e.cost) bits.push("$" + e.cost.toFixed(4));
      if (e.ms) bits.push((e.ms / 1000).toFixed(1) + "s");
      return bits.join("  ·  ");
    };
    for (const label of labels) {
      const e = state.cost[label];
      tIn += e.in; tOut += e.out; tCost += e.cost; tMs += e.ms; tTurns += e.turns;
      ui.line("   " + ui.c.blue(label.padEnd(22)) + ui.c.faint(fmt(e)));
    }
    ui.line("   " + ui.c.emerald(ui.t("cost.total").padEnd(22)) + ui.c.text(fmt({ turns: tTurns, in: tIn, out: tOut, cost: tCost, ms: tMs })));
  }

  function showDiff() {
    const { spawnSync } = require("node:child_process");
    const opt = { cwd: state.cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };
    const stat = spawnSync("git", ["-C", state.cwd, "--no-pager", "diff", "--stat"], opt);
    if (stat.status !== 0 && /not a git repository/i.test(stat.stderr || "")) return ui.warn(ui.t("diffNoGit"));
    const body = spawnSync("git", ["-C", state.cwd, "--no-pager", "diff"], opt);
    const statTxt = (stat.stdout || "").trim();
    const bodyTxt = (body.stdout || "").trim();
    ui.line("");
    if (!statTxt && !bodyTxt) return ui.info(ui.t("diffClean"));
    if (statTxt) ui.markdown(statTxt);
    if (bodyTxt) {
      ui.line("");
      for (const ln of bodyTxt.split("\n").slice(0, 500)) {
        if (ln.startsWith("+") && !ln.startsWith("+++")) ui.line(ui.c.green(ln));
        else if (ln.startsWith("-") && !ln.startsWith("---")) ui.line(ui.c.paw(ln));
        else if (ln.startsWith("@@")) ui.line(ui.c.blue(ln));
        else ui.line(ui.c.dim(ln));
      }
    }
  }

  // !cmd — run a shell command in the working folder and show its output (display-only).
  function runShell(cmd) {
    if (!cmd) return;
    const { spawnSync } = require("node:child_process");
    ui.tool("$ " + cmd);
    const r = spawnSync("bash", ["-lc", cmd], { cwd: state.cwd, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    ui.toolResult(out || ("exit " + (r.status == null ? "?" : r.status)), r.status === 0 || r.status == null);
  }

  // @path — inline the contents of mentioned files into the prompt as fenced context.
  function expandMentions(text) {
    const fs = require("node:fs");
    const path = require("node:path");
    const seen = new Set();
    const blocks = [];
    const re = /(^|\s)@([^\s]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const p = m[2];
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const abs = path.isAbsolute(p) ? p : path.resolve(state.cwd, p);
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= 256 * 1024) {
          blocks.push("File: " + p + "\n```\n" + fs.readFileSync(abs, "utf8").slice(0, 20000) + "\n```");
        }
      } catch { /* not a readable file — leave the @token as plain text */ }
    }
    return blocks.length ? text + "\n\n" + blocks.join("\n\n") : text;
  }

  async function handleSlash(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help":
      case "?":
        printHelp(ui);
        return true;
      case "agents":
        printRoster();
        return true;
      case "team":
        arg ? setTeam(arg) : printTeam();
        return true;
      case "firms": {
        const fs = H.listFirms(db);
        ui.line("");
        for (const f of fs) ui.line("  " + ui.c.emerald(f.slug.padEnd(28)) + ui.c.text(f.name) + ui.c.dim("  (CEO)"));
        return true;
      }
      case "agent":
        if (!arg) return ui.warn(ui.t("agentUsage")), true;
        switchSubject("agent", arg);
        return true;
      case "firm":
        if (!arg) return ui.warn(ui.t("firmUsage")), true;
        switchSubject("firm", arg);
        return true;
      case "runtime":
        setRuntime(arg);
        return true;
      case "model":
        if (state.runtime.mode !== "api") return ui.warn(ui.t("modelOnlyApi")), true;
        state.runtime.model = arg || null;
        ui.ok(ui.t("modelSet", state.runtime.model || ui.t("modelDefault")));
        return true;
      case "permission":
      case "perm": {
        const p = (arg || "").toLowerCase();
        if (!["read", "write", "full"].includes(p)) return ui.warn(ui.t("permUsage")), true;
        state.permission = p;
        ui.ok(ui.t("permSet", p));
        return true;
      }
      case "cwd":
        if (arg) {
          const path = require("node:path");
          const fs = require("node:fs");
          const next = path.resolve(state.cwd, arg);
          if (!fs.existsSync(next)) return ui.error(ui.t("cwdNoPath", next)), true;
          state.cwd = next;
          state.native = {};
          if (H.projectPathFor) state.projectPath = H.projectPathFor(db, next);
          ui.ok(ui.t("cwdSet", banner.shorten(next)));
        } else {
          ui.info(state.cwd);
        }
        return true;
      case "memory": {
        const mem = H.cliMemoryContext(db, state.projectPath);
        ui.line("");
        ui.markdown(mem || ui.t("noMemory"));
        return true;
      }
      case "clear":
        state.history = [];
        state.native = {};
        if (ui.enabled) process.stdout.write("\x1b[2J\x1b[H");
        showBanner();
        return true;
      case "import":
        if (!arg) return ui.warn(ui.t("importUsage")), true;
        try {
          const r = H.importLocal(db, arg);
          ui.ok(ui.t(r.updated ? "updated" : "imported", r.name, r.kind));
        } catch (e) {
          ui.error((e && e.message) || String(e));
        }
        return true;
      case "doctor":
        H.doctor(db, ui);
        return true;
      case "status":
        banner.renderStatus({ ui, runtimeLabel: runtimeLabel(state.runtime), subjectLabel: state.subject && state.subject.label, permission: state.permission, cwd: state.cwd });
        return true;
      case "cost":
        printCost();
        return true;
      case "multimodal": {
        const [sub, modality, providerId] = arg.trim().split(/\s+/);
        if (sub === "set") {
          if (!H.setMultimodal) return ui.warn("multimodal settings unavailable"), true;
          try {
            H.setMultimodal(db, modality, providerId);
            ui.ok(ui.t("multimodal.set", modality || "", providerId || ""));
          } catch (e) {
            ui.error((e && e.message) || String(e));
          }
        }
        if (H.multimodalStatus) {
          const rows = await H.multimodalStatus(db);
          ui.line("");
          ui.line(ui.c.dim("  " + ui.t("multimodal.title")));
          for (const row of rows) {
            const env = row.env.length
              ? row.env.map((e) => `${e.key}:${e.hasValue ? "set" : "missing"}`).join(" ")
              : "no key";
            ui.line("   " + ui.c.blue(row.modality.padEnd(7)) + ui.c.text(row.provider.id.padEnd(22)) + ui.c.dim(env));
          }
          ui.line("   " + ui.c.faint(ui.t("multimodal.usage")));
        }
        return true;
      }
      case "diff":
        showDiff();
        return true;
      case "history": {
        const items = (rl.history || []).slice(0, 30);
        ui.line("");
        if (!items.length) { ui.info(ui.t("noHistory")); return true; }
        for (let i = 0; i < items.length; i++) ui.line("   " + ui.c.faint(String(i + 1).padStart(3)) + "  " + ui.c.text(items[i]));
        return true;
      }
      case "exit":
      case "quit":
      case "q":
        ui.line(ui.c.emerald("🦖 ") + ui.c.dim(ui.t("bye")));
        rl.close();
        process.exit(0);
        return false;
      default:
        ui.warn(ui.t("unknownCmd", cmd));
        return true;
    }
  }

  // ── interactive picker (when no agent was given) ──
  function chooseAndStart(setter, row) {
    setter(row);
    ui.ok(ui.t("switched", state.subject.label));
    routingNote(state.subject);
    ask();
  }
  function pick() {
    if (closed) return process.exit(0);
    printRoster();
    rl.question("\n   " + ui.c.emerald(ui.t("picker.prompt")), async (line) => {
      const t = (line || "").trim();
      if (!t) return pick();
      if (t === "/exit" || t === "/quit" || t === "/q") {
        ui.line(ui.c.emerald("🦖 ") + ui.c.dim(ui.t("bye")));
        rl.close();
        return process.exit(0);
      }
      if (t === "/help" || t === "/?") {
        printHelp(ui);
        return pick();
      }
      if (/^\/import\s+/.test(t)) {
        try {
          const r = H.importLocal(db, t.replace(/^\/import\s+/, "").trim());
          ui.ok(ui.t(r.updated ? "updated" : "imported", r.name, r.kind));
        } catch (e) {
          ui.error((e && e.message) || String(e));
        }
        return pick();
      }
      const ags = H.listAgents(db);
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (n >= 1 && n <= ags.length) return chooseAndStart(setSubjectAgent, ags[n - 1]);
        ui.warn(ui.t("picker.noNum"));
        return pick();
      }
      if (/^firm\s+/i.test(t)) {
        const f = H.resolveFirm(db, t.replace(/^firm\s+/i, "").trim());
        if (f) return chooseAndStart(setSubjectFirm, f);
        ui.warn(ui.t("picker.noFirm"));
        return pick();
      }
      const a = H.resolveAgent(db, t);
      if (a) return chooseAndStart(setSubjectAgent, a);
      const f = H.resolveFirm(db, t);
      if (f) return chooseAndStart(setSubjectFirm, f);
      if (H.autoRouteAgent) {
        const choice = H.autoRouteAgent(db, t, ui.lang);
        if (choice) {
          setSubjectAgent(choice.agent);
          state.routePreambleOnce = H.autoRoutePreamble ? H.autoRoutePreamble(choice, ui.lang) : null;
          ui.info(H.autoRouteNote ? H.autoRouteNote(choice, ui.lang) : `auto-routed to ${choice.agent.name}`);
          routingNote(state.subject);
          await runTurn(t);
          return ask();
        }
      }
      ui.warn(ui.t("picker.noMatch", t));
      return pick();
    });
  }

  // ── main loop ── (multiline: a trailing "\\" continues the input)
  function ask(buffer) {
    if (closed) return process.exit(0);
    const cont = buffer != null;
    rl.question(cont ? ui.c.dim("   … ") : "\n" + ui.promptLabel(), async (line) => {
      if (input.isContinuation(line)) {
        return ask((cont ? buffer + "\n" : "") + input.stripContinuation(line));
      }
      const full = (cont ? buffer + "\n" : "") + (line || "");
      const t = full.trim();
      if (!t) return ask();
      if (rl.terminal && rl.history && rl.history[0] !== t) rl.history.unshift(t);
      input.persistHistory(rl);
      if (t.startsWith("!")) {
        runShell(t.slice(1).trim());
        return ask();
      }
      if (t.startsWith("/")) {
        const c2 = await handleSlash(t);
        if (c2 === false) return;
        return ask();
      }
      await runTurn(expandMentions(t));
      ask();
    });
  }

  // ── boot: first-run wizard, then banner + picker/loop ──
  async function bootstrap() {
    if (!prefs.onboarded) {
      try {
        const { runOnboard } = require("./agentlas-onboard.cjs");
        const result = await runOnboard({ ui, rl, helpers: H });
        Object.assign(prefs, result);
        ui.lang = prefs.lang || "en";
        state.permission = prefs.permission || state.permission;
        if (prefs.runtime && prefs.runtime !== "auto" && H.RUNTIME_BIN[prefs.runtime] && H.which(H.RUNTIME_BIN[prefs.runtime])) {
          state.runtime = { mode: "cli", kind: prefs.runtime };
        }
        if (opts.savePrefs) opts.savePrefs(prefs);
        ui.line("");
      } catch (e) {
        ui.error((e && e.message) || String(e));
      }
    }
    baseRuntime = state.runtime; // lock in the session default (post-wizard) before per-agent routing
    if (state.subject && state.subject.capAgent) {
      applyRuntimeFor(state.subject);
      // refresh the label for the chosen language (initial subject came pre-built from the entry)
      state.subject.label = displayName(state.subject.capAgent) + (state.subject.kind === "firm" ? " CEO" : "");
    }
    showBanner();
    if (state.subject) {
      routingNote(state.subject);
      ask();
    } else {
      pick();
    }
  }
  bootstrap();
}

function printHelp(ui) {
  const c = ui.c;
  const rows = [
    [ui.t("help.talkKey"), ui.t("help.talk")],
    ["/agents", ui.t("help.agents")],
    ["/team [agent rt]", ui.t("help.team")],
    ["/agent <name>", ui.t("help.agent")],
    ["/firms · /firm <name>", ui.t("help.firms")],
    ["/runtime <kind>", ui.t("help.runtime")],
    ["/model <id>", ui.t("help.model")],
    ["/permission <lvl>", ui.t("help.permission")],
    ["/cwd [path]", ui.t("help.cwd")],
    ["/memory", ui.t("help.memory")],
    ["/cost", ui.t("help.cost")],
    ["/multimodal", ui.t("help.multimodal")],
    ["/diff", ui.t("help.diff")],
    ["/history", ui.t("help.history")],
    ["/import <path>", ui.t("help.import")],
    ["/clear", ui.t("help.clear")],
    ["/doctor", ui.t("help.doctor")],
    ["/exit", ui.t("help.exit")],
  ];
  ui.line("");
  for (const [k, v] of rows) ui.line("  " + c.emerald(k.padEnd(24)) + c.dim(v));
  ui.line("");
  ui.line("  " + c.faint(ui.t("help.tipsTitle")));
  const tips = [
    ["@path", ui.t("help.atfile")],
    ["!cmd", ui.t("help.bang")],
    ["\\ + Enter", ui.t("help.multiline")],
    ["Tab", ui.t("help.tab")],
  ];
  for (const [k, v] of tips) ui.line("  " + c.emerald(k.padEnd(24)) + c.dim(v));
}

module.exports = { startRepl, runtimeLabel };
