// 문서 → PDF 내보내기.
//
// 앱에는 PDF 생성 경로가 하나도 없었다. Document Studio 는 Markdown/HTML 만
// 내보냈고, 빌더가 만드는 논문 에이전트는 계약서에 "compiled manuscript/main.pdf
// (when authorized tooling is available)" 라고 적어두는데 그 tooling 을 호출하는
// 코드가 어디에도 없었다. 그래서 계약의 조건절이 앱 안에서는 영원히 거짓이었다.
//
// 두 경로를 둔다. 어느 쪽으로 만들었는지는 항상 결과에 담아 돌려준다 — 조판
// 품질이 다른 두 산출물을 같은 것처럼 보이게 하지 않기 위해서다.
//   1. pandoc + tectonic  → 진짜 LaTeX 조판. 논문용.
//   2. Chromium printToPDF → 의존성 0. 툴체인이 없는 사용자를 빈손으로 보내지 않는다.
import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detachedSpawnOpts, killCliTree, trackRunChild } from "../runtime/exec";

export type DocumentPdfEngine = "tectonic" | "chromium";

export interface DocumentPdfResult {
  ok: boolean;
  /** 어떤 경로로 만들었는지. 호출자는 이걸 사용자에게 그대로 보여줘야 한다. */
  engine?: DocumentPdfEngine;
  /**
   * Chromium 으로 내려온 이유. "toolchain-missing" 과 "typeset-failed" 는 사용자가
   * 할 일이 완전히 다르다 — 하나는 설치, 하나는 문서 수정이다. 하나로 뭉뚱그리면
   * 툴체인이 깔린 사람에게 "없다"고 거짓말하게 된다.
   */
  degraded?: "toolchain-missing" | "typeset-failed";
  /** degraded === "typeset-failed" 일 때 조판기가 실제로 뱉은 사유. */
  degradedReason?: string;
  bytes?: number;
  reason?: string;
}

export interface DocumentPdfInput {
  /** 문서 제목. LaTeX/HTML 양쪽 머리말에 쓰인다. */
  title: string;
  /** 본문(Markdown). */
  markdown: string;
  /** 최종 PDF 를 쓸 절대 경로. 호출자(Main)가 정한다 — 렌더러 경로는 권한이 아니다. */
  targetPath: string;
  /** 그림 캡션이 있으면 본문 끝에 붙인다. */
  figureCaption?: string;
}

const TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(os.homedir(), ".local/bin")];

function resolveTool(name: string): string | null {
  const fromPath = (process.env.PATH || "").split(":").filter(Boolean).map((dir) => path.join(dir, name));
  for (const candidate of [...TOOL_DIRS.map((dir) => path.join(dir, name)), ...fromPath]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      ...detachedSpawnOpts(),
    });
    trackRunChild(child);
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        killCliTree(child, 250);
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** pandoc 으로 Markdown → PDF (조판 엔진은 tectonic). 둘 다 있어야 시도한다. */
async function renderWithTectonic(input: DocumentPdfInput): Promise<DocumentPdfResult | null> {
  const pandoc = resolveTool("pandoc");
  const tectonic = resolveTool("tectonic");
  if (!pandoc || !tectonic) return null;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-pdf-"));
  try {
    const sourcePath = path.join(workDir, "manuscript.md");
    const body = input.figureCaption?.trim()
      ? `${input.markdown}\n\n*${input.figureCaption.trim()}*\n`
      : `${input.markdown}\n`;
    fs.writeFileSync(sourcePath, body, "utf8");

    // pandoc 이 tectonic 을 찾을 수 있도록 PATH 대신 절대 경로로 넘긴다.
    const result = await run(
      pandoc,
      [
        // Papers write inline/display math as \(…\) and \[…\], which pandoc's
        // default markdown reader does NOT treat as math: it escapes the
        // backslashes, so \langle and friends reach LaTeX as literal text and
        // the run dies with "Missing $ inserted". Verified against the real
        // 27KB manuscript — off: texput.tex:367 fatal, on: 80KB PDF.
        "-f",
        "markdown+tex_math_single_backslash",
        "manuscript.md",
        "-o",
        input.targetPath,
        `--pdf-engine=${tectonic}`,
        "--metadata",
        `title=${input.title || "Document"}`,
        "--variable",
        "geometry:margin=1in",
        "--variable",
        "fontsize=11pt",
      ],
      workDir,
      180_000,
    );
    if (result.code !== 0 || !fs.existsSync(input.targetPath)) {
      // 조판 실패는 숨기지 않는다. 호출자가 Chromium 으로 내려갈지 결정한다.
      // stderr 첫 줄은 거의 항상 폰트 경고라, 그걸 보여주면 원인을 가린다 —
      // 실제 error 줄을 골라낸다.
      const lines = result.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
      const fatal = lines.find((line) => /^error[: ]/i.test(line) || /^!/.test(line));
      return {
        ok: false,
        engine: "tectonic",
        reason: (fatal ?? lines[lines.length - 1] ?? `pandoc exited ${result.code}`).slice(0, 400),
      };
    }
    return { ok: true, engine: "tectonic", bytes: fs.statSync(input.targetPath).size };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Markdown 을 최소한의 문서형 HTML 로. 외부 렌더러 의존 없이 Main 안에서 끝낸다. */
function markdownToHtml(input: DocumentPdfInput): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (value: string) =>
    escape(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  const lines = input.markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inCode = false;
  let listOpen = false;
  let tableRows: string[][] = [];

  const flushList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };
  const flushTable = () => {
    if (tableRows.length === 0) return;
    const [head, ...body] = tableRows;
    html.push("<table>");
    html.push(`<thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`);
    html.push("<tbody>");
    for (const row of body) html.push(`<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`);
    html.push("</tbody></table>");
    tableRows = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      html.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(escape(raw));
      continue;
    }
    // 표: | a | b | 형태. 구분선(---)은 건너뛴다.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushList();
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) tableRows.push(cells);
      continue;
    }
    flushTable();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    html.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  flushTable();
  if (inCode) html.push("</code></pre>");

  if (input.figureCaption?.trim()) html.push(`<p class="caption">${inline(input.figureCaption.trim())}</p>`);

  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>${escape(input.title || "Document")}</title>`,
    "<style>",
    "body{font-family:Georgia,'Times New Roman',serif;font-size:11pt;line-height:1.55;color:#111;margin:0;}",
    "h1{font-size:20pt;margin:0 0 12pt;} h2{font-size:14pt;margin:18pt 0 8pt;} h3{font-size:12pt;margin:14pt 0 6pt;}",
    "p{margin:0 0 9pt;text-align:justify;}",
    "ul{margin:0 0 9pt 18pt;padding:0;}",
    "table{border-collapse:collapse;width:100%;margin:10pt 0;font-size:10pt;}",
    "th,td{border:1px solid #bbb;padding:4pt 6pt;text-align:left;vertical-align:top;}",
    "th{background:#f2f2f2;}",
    "pre{background:#f6f6f6;border:1px solid #ddd;padding:8pt;overflow:auto;font-size:9pt;}",
    "code{font-family:ui-monospace,Menlo,monospace;}",
    ".caption{font-style:italic;color:#444;}",
    "</style></head><body>",
    `<h1>${escape(input.title || "Document")}</h1>`,
    html.join("\n"),
    "</body></html>",
  ].join("\n");
}

/** 의존성 없는 폴백. Electron 이 이미 Chromium 을 갖고 있으므로 항상 가능하다. */
async function renderWithChromium(input: DocumentPdfInput): Promise<DocumentPdfResult> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true },
  });
  try {
    const html = markdownToHtml(input);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 },
    });
    fs.writeFileSync(input.targetPath, pdf);
    return { ok: true, engine: "chromium", bytes: pdf.byteLength };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * LaTeX 조판을 먼저 시도하고, 툴체인이 없거나 조판이 실패하면 Chromium 으로 내려간다.
 * 내려간 경우 `degraded: true` 로 표시해 호출자가 "LaTeX 로 만든 것"처럼 말하지 못하게 한다.
 */
export async function renderDocumentPdf(input: DocumentPdfInput): Promise<DocumentPdfResult> {
  if (!input.markdown.trim()) return { ok: false, reason: "empty document" };
  // null = 툴체인 자체가 없어 시도조차 못 함. ok:false = 있었는데 조판이 실패함.
  const latex = await renderWithTectonic(input);
  if (latex?.ok) return latex;
  const fallback = await renderWithChromium(input);
  if (!fallback.ok) {
    // 두 경로 다 실패 — LaTeX 쪽 사유가 있으면 그것도 함께 보고한다.
    return { ok: false, reason: [latex?.reason, fallback.reason].filter(Boolean).join(" / ") || "pdf export failed" };
  }
  return {
    ...fallback,
    degraded: latex === null ? "toolchain-missing" : "typeset-failed",
    ...(latex?.reason ? { degradedReason: latex.reason } : {}),
  };
}

/** 이 컴퓨터에서 어떤 PDF 경로가 가능한지. UI 가 미리 정직하게 안내하기 위한 것. */
export function documentPdfCapability(): { latex: boolean; chromium: true } {
  return { latex: Boolean(resolveTool("pandoc") && resolveTool("tectonic")), chromium: true };
}
