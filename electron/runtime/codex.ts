// Codex CLI — 감지 + 실호출.
// 사용자의 ChatGPT Plus/Pro 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: codex exec "<prompt>"  (—— Codex CLI의 exec 모드)
// V0는 single-turn; 이전 대화를 user 입력에 inline.
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { agentRunCwd, probeCliVersion, spawnCli, writeStdin } from "./exec";

const CANDIDATES = [
  "codex",
  path.join(os.homedir(), ".local/bin/codex"), // 네이티브 인스톨러 기본 위치
  path.join(os.homedir(), ".codex/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  // Windows npm 전역 심 — GUI 앱이 PATH를 못 받았을 때의 fallback.
  ...(process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? "", "npm", "codex.cmd"),
        path.join(process.env.LOCALAPPDATA ?? "", "npm", "codex.cmd"),
      ]
    : []),
];

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (!path.isAbsolute(p)) {
      // bare 커맨드명 — PATH(+Windows PATHEXT)로 해석. .cmd 심 포함.
      if ((await probeCliVersion(p, 2000)) !== null) return p;
      continue;
    }
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

export interface CodexProbe {
  path: string;
  version: string;
}

export async function probeCodex(): Promise<CodexProbe | null> {
  const found = await firstExisting(CANDIDATES);
  if (!found) return null;
  const version = (await probeCliVersion(found)) ?? "unknown";
  return { path: found, version };
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeCodex();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(req.systemPrompt, req.locale, req.permission);
  const user = tStatus(req.locale, "speakerUser");
  const assistant = tStatus(req.locale, "speakerAssistant");
  const parts: string[] = [`[SYSTEM]\n${sys}`, ""];
  if (req.history.length > 0) {
    parts.push(tStatus(req.locale, "histPrevSection"));
    for (const m of req.history) {
      const tag = m.role === "user" ? user : assistant;
      parts.push(`${tag}: ${m.text}`);
    }
    parts.push("");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

function permissionArgs(permission?: RunnerRequest["permission"]): string[] {
  if (permission === "write" || permission === "full") {
    // Agentlas runs Codex as a local, user-owned automation runtime. For browser
    // setup flows, confirmation prompts break the "do it for me" contract.
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  // `codex exec`는 비대화형이라 approval loop가 없다 — 승인 플래그를 받지 않는다.
  // (`--ask-for-approval`은 대화형 `codex` 전용. exec에 넘기면 0.133+에서
  //  `unexpected argument` 로 exit 2.) read 권한은 read-only 샌드박스로 충분.
  return ["--sandbox", "read-only"];
}

export const runCodex: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingCodex"));
  }

  if (req.images && req.images.length > 0) {
    events.onStatus(tStatus(req.locale, "cliNoImage", { backend: req.backendLabel }));
  } else {
    events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  }

  const prompt = buildPrompt(req);
  const permArgs = permissionArgs(req.permission);
  const mcpArgs =
    req.mcpCodexConfigArgs && req.mcpCodexConfigArgs.length > 0
      ? req.mcpCodexConfigArgs
      : [];

  return new Promise<RunnerResult>((resolve, reject) => {
    // codex CLI의 비대화형 실행 모드 — exec 서브명령.
    // --skip-git-repo-check: cwd가 git 레포가 아니어도 실행 ("not inside a trusted directory" 방지).
    // 프롬프트는 argv가 아니라 stdin으로 전달 — `-`는 "stdin에서 읽어라" sentinel.
    // (Windows cmd.exe 8191자 한계로 큰 프롬프트가 잘려 exit 1 나는 것 방지. writeStdin 참고.)
    const child = spawnCli(bin, ["exec", "--skip-git-repo-check", ...permArgs, ...mcpArgs, "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: req.env ?? process.env,
      // 사용자가 지정한 프로젝트 폴더에서 실행 — 미지정이면 전용 폴더.
      cwd: req.cwd ?? agentRunCwd(),
    });
    writeStdin(child, prompt);

    // 취소 — Stop 누르면 자식 프로세스 종료.
    const onAbort = () => child.kill();
    if (req.signal) {
      if (req.signal.aborted) child.kill();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    let stderr = "";
    let lastEmit = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      const now = Date.now();
      if (now - lastEmit > 80) {
        events.onPartial(stdout);
        lastEmit = now;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      req.signal?.removeEventListener("abort", onAbort);
      if (req.signal?.aborted) {
        reject(new Error(tStatus(req.locale, "aborted")));
        return;
      }
      if (code === 0) {
        resolve({ text: stdout.trim() });
      } else {
        reject(
          new Error(
            `codex CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
};
