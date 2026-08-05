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
  /**
   * 스크립트가 쓰는 서드파티 파이썬 패키지의 pip 이름들.
   * ★근본 배경(실측 2026-08-05): AI가 `import yfinance`를 쓰는 코드를 지었는데 번들
   * 런타임에 그 패키지가 없어, 아침 리포트가 매번 같은 자리에서 원문 traceback으로
   * 죽었다. 코드를 지어 주는 제품이 "그 코드가 돌 환경"까지 책임지지 않으면
   * 그래프는 복잡하지 않아도 죽는다. 선언된 패키지는 실행 **전에** 커널이 설치한다.
   */
  packages?: string[];
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
  /**
   * 실패의 기계 이름 — 지금은 의존성 결손 하나뿐.
   * 원문 traceback만 던지면 화면이 판정 문장으로 덮어쓴다(기계 표식 소실 사고의 재발 방지).
   */
  failureCode?: "CODE_DEPENDENCY_MISSING";
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

// ── 파이썬 서드파티 패키지 — 커널이 실행 전에 설치한다 ─────────────────────
//
// 설치는 **스텝 샌드박스 밖**에서 한다. 스텝은 read면 네트워크가 차단되지만, 설치는
// 커널이 하는 준비 작업이라 그 차단과 충돌하지 않는다. 설치 대상은 관리 폴더 하나이고
// 스텝에는 PYTHONPATH로만 붙는다 — 번들 런타임 자체를 오염시키지 않는다.

/** pip 인자로 안전한 이름만. spawn이라 셸 주입은 없지만 "-"로 시작하면 pip 옵션이 된다. */
function safePipName(name: string): string | null {
  const v = String(name || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?(==[A-Za-z0-9.*+!_-]+)?$/.test(v) ? v : null;
}

function pythonDepsDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require("electron") as { app?: { getPath?: (k: string) => string } };
    if (app?.getPath) return path.join(app.getPath("userData"), "code-deps", "py");
  } catch { /* 테스트·CLI 컨텍스트 */ }
  return path.join(os.tmpdir(), "agentlas-code-deps", "py");
}

function depsManifestPath(dir: string): string {
  return path.join(dir, ".installed.json");
}

function readInstalled(dir: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(depsManifestPath(dir), "utf8")) as { installed?: string[] };
    return new Set((raw.installed ?? []).map((s) => s.toLowerCase()));
  } catch { return new Set(); }
}

function recordInstalled(dir: string, name: string): void {
  const set = readInstalled(dir);
  set.add(name.toLowerCase());
  try {
    fs.writeFileSync(depsManifestPath(dir), JSON.stringify({ installed: [...set].sort() }, null, 2) + "\n", "utf8");
  } catch { /* 기록 실패는 재설치로 이어질 뿐 — pip은 멱등이다 */ }
}

/** 선언된 패키지들을 관리 폴더에 설치한다. 실패한 패키지와 사유를 돌려준다. */
async function ensurePythonPackages(
  python: string,
  packages: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; installedNow: string[]; failed?: { name: string; reason: string } }> {
  const dir = pythonDepsDir();
  fs.mkdirSync(dir, { recursive: true });
  const have = readInstalled(dir);
  const installedNow: string[] = [];
  for (const raw of packages) {
    const name = safePipName(raw);
    if (!name) return { ok: false, installedNow, failed: { name: String(raw), reason: "패키지 이름 형식이 올바르지 않습니다." } };
    if (have.has(name.toLowerCase())) continue;
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(python, [
        "-m", "pip", "install", "--target", dir,
        "--disable-pip-version-check", "--no-input", "--quiet", name,
      ], { env, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 180_000);
      child.on("close", (c) => { clearTimeout(timer); resolve({ code: c, err }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, err: String(e) }); });
    });
    if (r.code !== 0) {
      return { ok: false, installedNow, failed: { name, reason: r.err.trim().slice(-500) || `pip 종료 코드 ${r.code}` } };
    }
    recordInstalled(dir, name);
    installedNow.push(name);
  }
  return { ok: true, installedNow };
}

const MISSING_MODULE_RE = /ModuleNotFoundError: No module named '([^']+)'/;

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
    const provisionNotes: string[] = [];
    if (input.lang === "python") {
      // 관리 폴더는 항상 PYTHONPATH에 붙는다 — 이전 실행이 설치해 둔 것도 보인다.
      const depsDir = pythonDepsDir();
      env.PYTHONPATH = env.PYTHONPATH ? `${depsDir}${path.delimiter}${env.PYTHONPATH}` : depsDir;
      const declared = (input.packages ?? []).map((s) => String(s).trim()).filter(Boolean);
      if (declared.length) {
        const ensured = await ensurePythonPackages(interpreter, declared, env);
        if (ensured.installedNow.length) provisionNotes.push(`[deps] 설치: ${ensured.installedNow.join(", ")}`);
        if (!ensured.ok && ensured.failed) {
          return {
            ok: false, isolation: "process-isolated", failureCode: "CODE_DEPENDENCY_MISSING",
            reason: `이 단계가 선언한 파이썬 패키지 "${ensured.failed.name}"를 설치하지 못했습니다: ${ensured.failed.reason}`,
          };
        }
      }
    }
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
    const runOnce = async (): Promise<{ code: number | null; stdout: string; stderr: string }> => {
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
      return { code, stdout, stderr };
    };

    let run = await runOnce();
    if (input.signal?.aborted) {
      return { ok: false, isolation, reason: "실행이 중지되었습니다." };
    }
    // ── 미선언 import 구조(救助) — 없는 모듈이면 설치를 시도하고 딱 한 번 다시 돈다 ──
    //   선언이 정답이지만, 이미 저장된 그래프(선언 이전에 지어진 코드)를 원문 traceback으로
    //   죽게 두는 것은 도움이 아니다. 모듈 이름=pip 이름일 때는 이 구조가 그대로 살린다.
    //   (설치는 샌드박스 밖 커널 작업. 재시도는 같은 격리로 다시 돈다.)
    if (run.code !== 0 && input.lang === "python") {
      const missing = MISSING_MODULE_RE.exec(run.stderr)?.[1]?.split(".")[0];
      if (missing && safePipName(missing)) {
        const rescue = await ensurePythonPackages(interpreter, [missing], env);
        if (rescue.ok) {
          provisionNotes.push(`[deps] 없던 모듈 "${missing}" 설치 후 재시도`);
          run = await runOnce();
          if (input.signal?.aborted) {
            return { ok: false, isolation, reason: "실행이 중지되었습니다." };
          }
        } else if (rescue.failed) {
          return {
            ok: false, isolation, failureCode: "CODE_DEPENDENCY_MISSING",
            reason: `코드가 쓰는 파이썬 패키지 "${missing}"가 이 컴퓨터에 없고, 설치도 실패했습니다: `
              + `${rescue.failed.reason}`,
          };
        }
      }
    }
    if (run.code !== 0) {
      const stillMissing = input.lang === "python" ? MISSING_MODULE_RE.exec(run.stderr)?.[1] : null;
      const reason = run.stderr.trim() || `코드 스텝이 오류로 끝났습니다 (종료 코드 ${run.code}).`;
      if (stillMissing) {
        return {
          ok: false, isolation, failureCode: "CODE_DEPENDENCY_MISSING",
          reason: `코드가 쓰는 파이썬 모듈 "${stillMissing}"를 준비하지 못했습니다. pip 이름이 모듈 이름과 다른 패키지일 수 있습니다 — `
            + `원문: ${reason.slice(0, 800)}`,
        };
      }
      return { ok: false, isolation, reason: reason.slice(0, 4000) };
    }
    const { result, logs } = splitResult(run.stdout);
    const logOut = [provisionNotes.join("\n"), logs].filter(Boolean).join("\n");
    return { ok: true, result, isolation, stdout: logOut.slice(0, 4000) };
  } finally {
    cleanup();
  }
}
