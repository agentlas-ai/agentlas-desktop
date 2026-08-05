/**
 * 코드 스텝 실행기 — AI가 짠 스크립트를 **사용자 데스크탑에서 격리 실행**한다.
 *
 * 왜 이게 있나: 그래프의 "복잡한 스텝"(주가 계산·엑셀 가공·데이터 파싱)은 말로 시키면 숫자가
 * 조용히 틀린다. 그건 판단이 아니라 정확한 계산이라 **코드로 짜야** 한다. 그 코드는 사람이
 * 아니라 AI가 짜고, 여기가 그걸 돌리는 자리다.
 *
 * ★격리 등급을 결과에 정직하게 싣는다(도구 중개 C38과 같은 규율). 등급은 계획이 아니라 결과다:
 *   - macOS: `os-sandboxed` — Seatbelt(`/usr/bin/sandbox-exec`)로 read 코드의 **쓰기·네트워크를
 *     OS가 실제로 차단**한다. Codex CLI·Claude Code·Chromium·Bazel이 쓰는 검증된 경로
 *     (deprecated 표시는 있으나 대체재 없이 전부 현역 — 리서치 2026-08-05).
 *     ★macOS에서 샌드박스 구성이 실패하면 **폴백하지 않고 실패**한다 — 조용한 강등이 최악이다.
 *   - 그 외 OS: `process-isolated` — 별도 프로세스 + 타임아웃뿐. 윈도우는 관리자 권한 없이
 *     네트워크를 막을 실용 수단이 업계 전체에 없다(Codex도 비관리자 모드에선 포기,
 *     Claude Code는 네이티브 윈도우 미지원). 리눅스 bwrap/Landlock은 백로그.
 *   - 바깥을 바꾸는 코드(effect: mutation)는 어느 OS든 **실행 전 승인 게이트**를 지난다.
 *   - ★비밀 폴더는 read 코드도 **읽기 차단**(macOS) — 네트워크를 막아도 stdout이 유출 통로다:
 *     읽은 비밀이 결과 JSON에 실리면 LLM을 거쳐 밖으로 나간다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveHephaestusPython } from "../hephaestus/engine";
import { withPythonCacheBoundary } from "../runtime/python-cache";
import { agentRunCwd, killCliTree, nodeExecPathForCode } from "../runtime/exec";

export type CodeLang = "python" | "js";
export type CodeIsolationLevel = "os-sandboxed" | "process-isolated" | "unavailable";

export interface CodeRunInput {
  code: string;
  lang: CodeLang;
  /** 이 스텝이 읽는 그래프 변수들. 스크립트에 `vars`로 들어간다. */
  vars: Record<string, unknown>;
  /** 실행 작업 폴더(파일을 만들면 여기). 미지정이면 안전한 기본 폴더. */
  cwd?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  /** 노드의 선언 효과 — read/pure면 쓰기·네트워크를 OS가 차단한다(가능한 OS에서). */
  effect?: "pure" | "read" | "mutation";
}

export interface CodeRunResult {
  ok: boolean;
  /** 스크립트가 남긴 결과. 다음 노드가 읽는 값. */
  result?: unknown;
  /** 사람이 볼 실패 사유(스크립트 stderr 원문 우선). */
  reason?: string;
  /** 실제로 어떤 격리로 돌았나. 계획이 아니라 결과다. */
  isolation: CodeIsolationLevel;
  /** 스크립트가 stdout에 남긴 로그(결과 JSON 줄 제외). 소음 칸이라 다음 노드로 안 간다. */
  stdout?: string;
}

const RESULT_MARKER = "__AGENTLAS_CODE_RESULT__";

/**
 * 사용자(AI) 코드를 감싸는 하니스. 계약은 단순하다:
 *   - `vars`(dict/object)로 앞 단계 값을 받는다
 *   - `result`에 넣은 것이 다음 노드로 간다 (안 넣으면 null)
 *   - 결과는 **마지막 한 줄**에 마커와 함께 JSON으로 나온다. 그 위 stdout은 전부 로그(소음).
 */
function pythonHarness(code: string): string {
  return [
    "import json, sys",
    "_in = json.load(sys.stdin) if not sys.stdin.isatty() else {}",
    "vars = _in.get('vars', {})",
    "result = None",
    "# === BEGIN AI CODE ===",
    code,
    "# === END AI CODE ===",
    `sys.stdout.write('\\n' + ${JSON.stringify(RESULT_MARKER)} + json.dumps({'result': result}, default=str, ensure_ascii=False))`,
  ].join("\n");
}

function jsHarness(code: string): string {
  return [
    "import { readFileSync } from 'node:fs';",
    "const _in = JSON.parse(readFileSync(0, 'utf8') || '{}');",
    "const vars = _in.vars || {};",
    "let result = null;",
    "(async () => {",
    "// === BEGIN AI CODE ===",
    code,
    "// === END AI CODE ===",
    `process.stdout.write('\\n' + ${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ result }));`,
    "})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });",
  ].join("\n");
}

/** stdout에서 결과 JSON 줄과 그 위 로그를 가른다. */
function splitResult(stdout: string): { result: unknown; logs: string } {
  const idx = stdout.lastIndexOf(RESULT_MARKER);
  if (idx < 0) return { result: null, logs: stdout };
  const logs = stdout.slice(0, idx).replace(/\n$/, "");
  const json = stdout.slice(idx + RESULT_MARKER.length).trim();
  try {
    const parsed = JSON.parse(json) as { result?: unknown };
    return { result: parsed.result ?? null, logs };
  } catch {
    return { result: null, logs: stdout };
  }
}

/** 스크립트를 임시 파일로 물질화 — argv로 코드를 넘기면 길이·따옴표에서 깨진다. */
function materializeScript(harness: string, lang: CodeLang): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-code-"));
  const file = path.join(dir, lang === "python" ? "step.py" : "step.mjs");
  fs.writeFileSync(file, harness, { encoding: "utf8", mode: 0o600 });
  return {
    file,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

export async function runCodeStep(input: CodeRunInput): Promise<CodeRunResult> {
  const timeoutMs = Math.max(1, Math.min(600, input.timeoutSeconds ?? 60)) * 1000;
  const cwd = input.cwd ?? agentRunCwd();

  let interpreter: string;
  let harness: string;
  if (input.lang === "python") {
    const py = await resolveHephaestusPython();
    if (!py) {
      return {
        ok: false, isolation: "unavailable",
        reason: "이 컴퓨터에서 파이썬 실행기를 찾지 못했습니다. 앱을 다시 설치하거나 파이썬을 설치해 주세요.",
      };
    }
    interpreter = py.python;
    harness = pythonHarness(input.code);
  } else {
    interpreter = nodeExecPathForCode();
    harness = jsHarness(input.code);
  }

  const { file, cleanup } = materializeScript(harness, input.lang);
  try {
    const env = input.lang === "python"
      ? withPythonCacheBoundary({ ...process.env })
      : { ...process.env };
    // ── macOS Seatbelt — read 코드의 쓰기·네트워크를 OS가 실제로 차단 ──────
    const wantSandbox = process.platform === "darwin" && input.effect !== "mutation";
    let command = interpreter;
    let args = [file];
    let isolation: CodeIsolationLevel = "process-isolated";
    if (wantSandbox) {
      // (allow default) 후 deny — 인터프리터가 자기 dylib·/dev/urandom을 읽어야 해서
      // (deny default)는 못 쓴다(Bazel·Codex와 같은 접근). 쓰기는 스크립트 폴더·tmp·
      // 파이썬 캐시 경계만 열고, 네트워크는 전면 차단, 비밀 폴더는 읽기도 차단한다.
      const home = os.homedir();
      const writable = [path.dirname(file), os.tmpdir(), cwd];
      const denyRead = [
        path.join(home, ".ssh"), path.join(home, ".aws"),
        path.join(home, ".config", "gh"), path.join(home, ".gnupg"),
        path.join(home, "Library", "Keychains"),
      ];
      const esc = (p: string) => p.replace(/"/g, '\\"');
      const profile = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny file-write*)",
        ...writable.map((p) => `(allow file-write* (subpath "${esc(p)}"))`),
        ...denyRead.map((p) => `(deny file-read* (subpath "${esc(p)}"))`),
      ].join("\n");
      command = "/usr/bin/sandbox-exec";
      args = ["-p", profile, interpreter, file];
      isolation = "os-sandboxed";
      if (!fs.existsSync(command)) {
        // ★조용한 폴백 금지 — 울타리 없이 돌리고 "격리했다"고 말하는 것이 최악이다.
        return {
          ok: false, isolation: "unavailable",
          reason: "macOS 샌드박스 실행기(sandbox-exec)를 찾지 못해 코드를 돌리지 않았습니다.",
        };
      }
    }
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    // 앞 단계 값을 stdin으로 넘긴다 — argv에 실으면 크기·따옴표에서 깨진다.
    try { child.stdin.write(JSON.stringify({ vars: input.vars })); child.stdin.end(); } catch { /* 프로세스가 이미 죽었을 수 있다 */ }

    const timer = setTimeout(() => { killCliTree(child); }, timeoutMs);
    const onAbort = () => killCliTree(child);
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const code: number | null = await new Promise((resolve) => {
      child.on("close", (c) => resolve(c));
      child.on("error", () => resolve(-1));
    });
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);

    if (input.signal?.aborted) {
      return { ok: false, isolation, reason: "실행이 중지되었습니다." };
    }
    if (code !== 0) {
      const reason = stderr.trim() || `코드 스텝이 오류로 끝났습니다 (종료 코드 ${code}).`;
      return { ok: false, isolation, reason: reason.slice(0, 4000) };
    }
    const { result, logs } = splitResult(stdout);
    return { ok: true, result, isolation, stdout: logs.slice(0, 4000) };
  } finally {
    cleanup();
  }
}
