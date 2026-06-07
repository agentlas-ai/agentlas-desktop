"use strict";
/*
 * Agentlas terminal UI primitives — self-contained, zero-dependency (CJS).
 *
 * Electron-as-Node로 실행되므로 외부 컬러 라이브러리(chalk v5 ESM 등)에 의존하지 않는다.
 * 24-bit truecolor ANSI를 직접 쓰고, NO_COLOR / 비-TTY 환경에서는 평문으로 폴백한다.
 * 브랜드 팔레트는 보스턴테리어 paw 마크(크림슨) + agentlas-desktop-banner.svg(그린/틸 액센트)에서 가져왔다.
 */

const i18n = require("./agentlas-i18n.cjs");

const RESET = "\x1b[0m";

function colorEnabled() {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true") return true;
  if (process.env.AGENTLAS_NO_COLOR === "1") return false;
  return !!process.stdout.isTTY;
}

// 브랜드 색 (R,G,B). banner.svg / paw mark 기준.
const BRAND = {
  paw: [214, 69, 58], // 크림슨 (보스턴테리어 발바닥)
  pawDim: [138, 45, 38],
  emerald: [110, 231, 183], // #6EE7B7
  green: [52, 211, 153], // #34D399
  lime: [217, 249, 157], // #D9F99D
  blue: [147, 197, 253], // #93C5FD
  amber: [251, 191, 36], // #FBBF24
  pink: [244, 114, 182], // #F472B6
  text: [229, 231, 235], // #E5E7EB
  dim: [107, 114, 128], // #6B7280
  faint: [75, 85, 99],
};

function makePalette(enabled) {
  const fg = (rgb) => (s) => (enabled ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}` : String(s));
  const sgr = (code) => (s) => (enabled ? `\x1b[${code}m${s}${RESET}` : String(s));
  return {
    paw: fg(BRAND.paw),
    pawDim: fg(BRAND.pawDim),
    emerald: fg(BRAND.emerald),
    green: fg(BRAND.green),
    lime: fg(BRAND.lime),
    blue: fg(BRAND.blue),
    amber: fg(BRAND.amber),
    pink: fg(BRAND.pink),
    text: fg(BRAND.text),
    dim: fg(BRAND.dim),
    faint: fg(BRAND.faint),
    bold: sgr("1"),
    italic: sgr("3"),
    underline: sgr("4"),
    inverse: sgr("7"),
  };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ANSI 시퀀스를 제거한 가시 폭 (대략) — wide char는 단순 1로 계산(충분).
function visibleWidth(s) {
  return stripAnsi(s).length;
}
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

class Ui {
  constructor(opts = {}) {
    this.enabled = opts.color != null ? opts.color : colorEnabled();
    this.c = makePalette(this.enabled);
    this.out = opts.stream || process.stdout;
    this.lang = opts.lang || "en";
    this.t = (key, ...args) => i18n.t(this.lang, key, ...args);
    this._spinTimer = null;
    this._spinText = "";
    this._spinFrame = 0;
    this._spinStart = 0;
    this._turnStart = null; // set by beginTurn() so the spinner shows total-turn elapsed
    this._streaming = false;
    this._atLineStart = true;
    this._lastUsage = null; // last per-turn usage (for session /cost ledger)
  }

  write(s) {
    this.out.write(s);
    if (s.length) this._atLineStart = s.endsWith("\n");
  }
  line(s = "") {
    this.stopSpinner();
    this.write(s + "\n");
  }
  // 줄 시작이 아니면 개행을 보장 (스트리밍/스피너 뒤 깔끔한 블록 시작용).
  ensureNl() {
    if (!this._atLineStart) this.write("\n");
  }

  rule(label) {
    const cols = (this.out.columns || 80);
    if (label) {
      const text = ` ${label} `;
      const dashes = Math.max(0, cols - visibleWidth(text) - 1);
      this.line(this.c.faint("─") + this.c.dim(text) + this.c.faint("─".repeat(dashes)));
    } else {
      this.line(this.c.faint("─".repeat(Math.max(0, cols - 1))));
    }
  }

  // ── 스피너 (stderr가 아닌 메인 스트림에, 같은 줄을 갱신) ──
  startSpinner(text) {
    if (!this.enabled || !this.out.isTTY) {
      // 폴백: 한 번만 상태 출력
      if (text && text !== this._spinText) this.line(this.c.dim("  " + text));
      this._spinText = text || "";
      return;
    }
    this._spinText = text || "";
    if (this._spinTimer) return;
    this._spinStart = Date.now();
    const tick = () => {
      const frame = SPINNER_FRAMES[this._spinFrame % SPINNER_FRAMES.length];
      this._spinFrame++;
      const start = this._turnStart || this._spinStart;
      const secs = Math.floor((Date.now() - start) / 1000);
      // Claude Code 스타일 라이브 메타: 경과초 + 중단 힌트 (1초 이상부터)
      const meta = secs >= 1 ? this.c.faint(`  (${secs}s · ${this.t ? this.t("spinnerStop") : "ctrl-c to stop"})`) : "";
      this.out.write("\r\x1b[2K" + this.c.emerald(frame) + " " + this.c.dim(this._spinText) + meta);
      this._atLineStart = false;
    };
    tick();
    this._spinTimer = setInterval(tick, 120);
    if (this._spinTimer.unref) this._spinTimer.unref();
  }

  // 턴 시작/끝 — 스피너가 (툴 사이에 멈췄다 다시 떠도) 총 턴 경과시간을 보여주도록.
  beginTurn() {
    this._turnStart = Date.now();
  }
  endTurn() {
    this._turnStart = null;
  }
  updateSpinner(text) {
    this._spinText = text || "";
    if (!this._spinTimer && this.enabled && this.out.isTTY) this.startSpinner(text);
  }
  stopSpinner() {
    if (this._spinTimer) {
      clearInterval(this._spinTimer);
      this._spinTimer = null;
      this.out.write("\r\x1b[2K");
      this._atLineStart = true;
    }
  }

  // ── 사용자/에이전트 라벨 ──
  promptLabel(name) {
    return this.c.paw("▌") + this.c.emerald(" › ");
  }
  agentHeader(name) {
    this.ensureNl();
    this.line("");
    this.line(this.c.paw("> ") + this.c.bold(this.c.text(name)));
  }

  // ── 스트리밍 텍스트 ──
  streamStart() {
    this.stopSpinner();
    this.ensureNl();
    this._streaming = true;
  }
  streamDelta(text) {
    if (!text) return;
    this.stopSpinner();
    this.write(this.c.text(text));
    this._streaming = true;
  }
  streamEnd() {
    if (this._streaming) {
      this.ensureNl();
      this._streaming = false;
    }
  }

  // ── 툴 호출/결과 라인 (claude/codex 스타일) ──
  tool(name, arg) {
    this.stopSpinner();
    this.ensureNl();
    const head = this.c.green("⏺ ") + this.c.bold(this.c.text(name));
    this.line(arg ? head + "  " + this.c.dim(truncate(String(arg), 200)) : head);
  }
  toolResult(text, ok = true) {
    this.stopSpinner();
    const body = truncate(String(text || "").trim(), 600);
    if (!body) {
      this.line("  " + (ok ? this.c.dim("✓ done") : this.c.paw("✗ error")));
      return;
    }
    const lines = body.split("\n");
    const marker = ok ? this.c.dim("  └ ") : this.c.paw("  └ ");
    for (let i = 0; i < lines.length; i++) {
      this.line((i === 0 ? marker : "    ") + this.c.dim(lines[i]));
    }
  }

  status(msg) {
    this.updateSpinner(msg);
  }
  info(msg) {
    this.line(this.c.dim("  " + msg));
  }
  ok(msg) {
    this.stopSpinner();
    this.line(this.c.green("✓ ") + this.c.text(msg));
  }
  warn(msg) {
    this.stopSpinner();
    this.line(this.c.amber("! ") + this.c.text(msg));
  }
  error(msg) {
    this.stopSpinner();
    this.line(this.c.paw("✗ ") + this.c.text(msg));
  }

  // 최종 텍스트(비스트리밍 경로)에 가벼운 마크다운 강조 적용 후 출력.
  markdown(text) {
    this.stopSpinner();
    this.ensureNl();
    for (const raw of String(text).split("\n")) {
      this.line(this.renderInline(raw));
    }
  }
  renderInline(line) {
    if (!this.enabled) return line;
    let s = line;
    // 헤딩
    const h = s.match(/^(#{1,6})\s+(.*)$/);
    if (h) return this.c.bold(this.c.emerald(h[2]));
    // 인라인 코드 `x`
    s = s.replace(/`([^`]+)`/g, (_m, g) => this.c.amber(g));
    // 굵게 **x**
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, g) => this.c.bold(g));
    // 불릿
    s = s.replace(/^(\s*)([-*])\s+/, (_m, sp) => sp + this.c.emerald("• "));
    return this.c.text(s);
  }

  cost(usage) {
    this._lastUsage = usage || null;
    if (!usage) return;
    const bits = [];
    if (usage.input_tokens != null || usage.output_tokens != null) {
      bits.push(`${usage.input_tokens ?? "?"}→${usage.output_tokens ?? "?"} tok`);
    }
    if (usage.cost_usd != null) bits.push(`$${Number(usage.cost_usd).toFixed(4)}`);
    if (usage.duration_ms != null) bits.push(`${(usage.duration_ms / 1000).toFixed(1)}s`);
    if (bits.length) this.line(this.c.faint("  " + bits.join("  ·  ")));
  }
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

module.exports = { Ui, colorEnabled, BRAND, stripAnsi, visibleWidth, truncate, SPINNER_FRAMES };
