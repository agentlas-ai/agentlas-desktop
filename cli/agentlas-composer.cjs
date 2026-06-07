"use strict";
/*
 * agentlas-composer: a raw-mode bottom input box (Claude Code / Hermes style).
 *
 *   ╭────────────────────────────────────────────╮
 *   │ › your message                              │
 *   ╰────────────────────────────────────────────╯
 *     claude-code · full · 12.3k tok · / for commands
 *     (slash suggestions render here while typing /…)
 *
 * Single-line field with horizontal scroll (fixed 3-line box → flicker-free clear/redraw).
 * Full line editing, persisted history, Tab/path/slash completion, slash palette.
 * Zero external deps. Caller falls back to readline when stdin/stdout is not a TTY.
 */
const readline = require("node:readline");

// East-Asian width: CJK / Hangul / Kana / fullwidth glyphs occupy 2 terminal cells.
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) // emoji / pictographs
  );
}
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20) return 0;
  return isWide(cp) ? 2 : 1;
}
function visWidth(s) {
  const clean = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let n = 0;
  for (const ch of clean) n += charWidth(ch);
  return n;
}

function createComposer(opts) {
  const out = opts.stream || process.stdout;
  const inp = opts.input || process.stdin;
  const ui = opts.ui;
  const c = ui.c;
  const loadHistory = opts.loadHistory || (() => []);
  const saveHistory = opts.saveHistory || (() => {});
  let history = (loadHistory() || []).filter((x) => typeof x === "string"); // index 0 = most recent

  function cols() {
    return Math.max(30, out.columns || process.stdout.columns || 80);
  }
  function boxWidth() {
    return Math.min(cols() - 1, 120);
  }

  // Build the rendered block (array of lines) + the cursor target column on the input line.
  function frame(state, ctx) {
    const w = boxWidth();
    const inner = w - 2; // chars between │ … │
    const glyph = " " + (ctx.glyph || "›") + " "; // " › "
    const glyphW = visWidth(glyph);
    const fieldW = Math.max(8, inner - glyphW);

    // horizontal scroll by visual width — keep the cursor visible (CJK-safe)
    let start = Math.min(state.scroll, state.cur);
    while (start < state.cur && visWidth(state.buf.slice(start, state.cur)) > fieldW - 1) start++;
    state.scroll = start;

    let shown = "";
    let ww = 0;
    for (let i = start; i < state.buf.length; ) {
      const ch = state.buf.codePointAt(i) > 0xffff ? state.buf.slice(i, i + 2) : state.buf[i];
      const cw = charWidth(ch);
      if (ww + cw > fieldW) break;
      shown += ch;
      ww += cw;
      i += ch.length;
    }
    const pad = " ".repeat(Math.max(0, fieldW - ww));
    const top = c.faint("╭" + "─".repeat(inner) + "╮");
    const mid = c.faint("│") + c.emerald(glyph) + c.text(shown) + pad + c.faint("│");
    const bot = c.faint("╰" + "─".repeat(inner) + "╯");
    const lines = [top, mid, bot];
    if (ctx.status) lines.push("  " + c.faint(ctx.status));

    const rows = state.suggest || [];
    rows.slice(0, 8).forEach((r, i) => {
      const cmd = String(r.command || "").padEnd(16);
      const desc = String(r.description || "");
      const label = (" " + cmd + " " + desc).slice(0, w);
      lines.push(i === state.suggestSel ? c.inverse(label) : " " + c.blue(cmd) + c.dim(desc.slice(0, w - 20)));
    });
    if (rows.length) lines.push(c.faint("  ↑↓ move · Tab complete · Enter run · Esc close"));

    const curCol = 1 + glyphW + visWidth(state.buf.slice(start, state.cur)); // 0-based visual column
    return { lines, curCol };
  }

  function render(state, ctx) {
    const f = frame(state, ctx);
    let seq = "";
    if (state.drawn > 0) seq += "\r\x1b[1A\x1b[0J"; // from input line: col0, up to top border, clear down
    seq += f.lines.join("\r\n");
    const up = f.lines.length - 1 - 1; // from last line up to the input line (index 1)
    if (up > 0) seq += "\x1b[" + up + "A";
    seq += "\r";
    if (f.curCol > 0) seq += "\x1b[" + f.curCol + "C";
    out.write(seq);
    state.drawn = f.lines.length;
  }

  function clearBox(state) {
    if (state.drawn > 0) {
      out.write("\r\x1b[1A\x1b[0J");
      state.drawn = 0;
    }
  }

  function read(ctx) {
    ctx = ctx || {};
    return new Promise((resolve) => {
      const state = { buf: "", cur: 0, scroll: 0, drawn: 0, suggest: [], suggestSel: 0, hist: -1, stash: "", dismissed: null };

      function refreshSuggest() {
        if (ctx.suggest && state.buf !== state.dismissed) {
          state.suggest = ctx.suggest(state.buf) || [];
        } else {
          state.suggest = [];
        }
        if (state.suggestSel >= state.suggest.length) state.suggestSel = 0;
      }
      function draw() {
        refreshSuggest();
        render(state, ctx);
      }

      const wasRaw = !!inp.isRaw;
      try { if (inp.setRawMode) inp.setRawMode(true); } catch { /* ignore */ }
      readline.emitKeypressEvents(inp);
      inp.resume();

      let ctrlc = 0;
      function done(result) {
        inp.removeListener("keypress", onKey);
        try { if (inp.setRawMode) inp.setRawMode(wasRaw); } catch { /* ignore */ }
        resolve(result);
      }
      function setBuf(s, cur) {
        state.buf = s;
        state.cur = cur == null ? s.length : Math.max(0, Math.min(cur, s.length));
        state.dismissed = null;
        draw();
      }
      function submit() {
        const value = state.buf;
        clearBox(state);
        out.write(c.paw("▌") + c.emerald(" › ") + c.text(value) + "\r\n");
        if (value.trim()) {
          history = history.filter((h) => h !== value);
          history.unshift(value);
          saveHistory(history);
        }
        done({ value });
      }

      function onKey(str, key) {
        key = key || {};
        const name = key.name;

        if (key.ctrl && name === "c") {
          if (state.buf.length) { ctrlc = 0; return setBuf("", 0); }
          const now = Date.now();
          if (now < ctrlc) { clearBox(state); return done({ exit: true }); }
          ctrlc = now + 1500;
          return;
        }
        if (key.ctrl && name === "d") {
          if (!state.buf.length) { clearBox(state); return done({ eof: true }); }
          return;
        }
        if (name === "return" || name === "enter") return submit();
        if (name === "escape") {
          if (state.suggest.length) { state.dismissed = state.buf; state.suggest = []; return render(state, ctx); }
          return setBuf("", 0);
        }
        if (name === "backspace" || (key.ctrl && name === "h")) {
          if (state.cur > 0) setBuf(state.buf.slice(0, state.cur - 1) + state.buf.slice(state.cur), state.cur - 1);
          return;
        }
        if (name === "delete") return setBuf(state.buf.slice(0, state.cur) + state.buf.slice(state.cur + 1), state.cur);
        if (name === "left") { if (state.cur > 0) { state.cur--; draw(); } return; }
        if (name === "right") { if (state.cur < state.buf.length) { state.cur++; draw(); } return; }
        if (name === "home" || (key.ctrl && name === "a")) { state.cur = 0; draw(); return; }
        if (name === "end" || (key.ctrl && name === "e")) { state.cur = state.buf.length; draw(); return; }
        if (key.ctrl && name === "u") return setBuf(state.buf.slice(state.cur), 0);
        if (key.ctrl && name === "k") return setBuf(state.buf.slice(0, state.cur), state.cur);
        if (key.ctrl && name === "w") {
          const left = state.buf.slice(0, state.cur).replace(/\s*\S+\s*$/, "");
          return setBuf(left + state.buf.slice(state.cur), left.length);
        }
        if (name === "up") {
          if (state.suggest.length) { state.suggestSel = (state.suggestSel - 1 + state.suggest.length) % state.suggest.length; state.buf = state.suggest[state.suggestSel].command; state.cur = state.buf.length; return render(state, ctx); }
          return histNav(1);
        }
        if (name === "down") {
          if (state.suggest.length) { state.suggestSel = (state.suggestSel + 1) % state.suggest.length; state.buf = state.suggest[state.suggestSel].command; state.cur = state.buf.length; return render(state, ctx); }
          return histNav(-1);
        }
        if (name === "tab") {
          if (state.suggest.length) { const cmd = state.suggest[state.suggestSel].command; state.dismissed = cmd; return setBuf(cmd, cmd.length); }
          if (ctx.complete) {
            const res = ctx.complete(state.buf) || [];
            const hits = res[0] || [];
            const token = res[1] || "";
            if (hits.length === 1) {
              const head = token ? state.buf.slice(0, state.buf.length - token.length) : state.buf;
              return setBuf(head + hits[0]);
            }
          }
          return;
        }
        // printable insert (single char or paste). Strip control/newlines → single-line field.
        if (str && !key.ctrl && !key.meta) {
          const text = String(str).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f]/g, "");
          if (text) return setBuf(state.buf.slice(0, state.cur) + text + state.buf.slice(state.cur), state.cur + text.length);
        }
      }

      function histNav(dir) {
        if (!history.length) return;
        if (state.hist === -1 && dir === 1) state.stash = state.buf;
        let i = state.hist + dir;
        if (i < -1) i = -1;
        if (i >= history.length) i = history.length - 1;
        state.hist = i;
        const v = i === -1 ? state.stash : history[i];
        state.buf = v;
        state.cur = v.length;
        draw();
      }

      inp.on("keypress", onKey);
      draw();
    });
  }

  return { read, setHistory: (h) => { history = (h || []).filter((x) => typeof x === "string"); } };
}

module.exports = { createComposer, visWidth };
