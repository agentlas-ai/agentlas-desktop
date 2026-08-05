/**
 * 코드 스텝 실행기 — AI가 짠 스크립트를 **사용자 데스크탑에서 격리 실행**한다.
 *
 * 왜 이게 있나: 그래프의 "복잡한 스텝"(주가 계산·엑셀 가공·데이터 파싱)은 말로 시키면 숫자가
 * 조용히 틀린다. 그건 판단이 아니라 정확한 계산이라 **코드로 짜야** 한다. 그 코드는 사람이
 * 아니라 AI가 짜고, 여기가 그걸 돌리는 자리다.
 *
 * ★격리 등급을 결과에 정직하게 싣는다(도구 중개 C38과 같은 규율). 지금 슬라이스의 격리는:
 *   - 별도 프로세스 + 타임아웃 (무한 루프·행이 실행 전체를 잡지 못한다)
 *   - 바깥을 바꾸는 코드(effect: mutation)는 **실행 전에 커널의 승인 게이트**를 지난다
 *     (파일 쓰기·삭제·전송을 사람이 먼저 본다. 노드별 "항상 허용"으로 풀 수 있다)
 *   - 읽기·계산(effect: read/pure)은 승인 없이 돈다
 *   이것은 "완전 격리"가 아니다. 파일시스템 jail·네트워크 정책은 다음 슬라이스다.
 *   그래서 등급을 `process-isolated`로 적고, 더 강한 격리가 붙기 전까지 그 이상을 주장하지 않는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveHephaestusPython } from "../hephaestus/engine";
import { withPythonCacheBoundary } from "../runtime/python-cache";
import { agentRunCwd, killCliTree, nodeExecPathForCode } from "../runtime/exec";

export type CodeLang = "python" | "js";
export type CodeIsolationLevel = "process-isolated" | "unavailable";

export interface CodeRunInput {
  code: string;
  lang: CodeLang;
  /** 이 스텝이 읽는 그래프 변수들. 스크립트에 `vars`로 들어간다. */
  vars: Record<string, unknown>;
  /** 실행 작업 폴더(파일을 만들면 여기). 미지정이면 안전한 기본 폴더. */
  cwd?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
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
    const child = spawn(interpreter, [file], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

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
      return { ok: false, isolation: "process-isolated", reason: "실행이 중지되었습니다." };
    }
    if (code !== 0) {
      const reason = stderr.trim() || `코드 스텝이 오류로 끝났습니다 (종료 코드 ${code}).`;
      return { ok: false, isolation: "process-isolated", reason: reason.slice(0, 4000) };
    }
    const { result, logs } = splitResult(stdout);
    return { ok: true, result, isolation: "process-isolated", stdout: logs.slice(0, 4000) };
  } finally {
    cleanup();
  }
}
