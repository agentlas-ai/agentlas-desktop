// Hephaestus 빌더(hep-build) 구동기.
//
// hep-build 는 프로그래matic 함수가 아니라 "LLM 빌더 에이전트 라우팅" surface 다(bin/hephaestus
// 가 단지 라우팅 텍스트만 출력함). 따라서 데스크탑은 자신의 활성 런타임(Claude Code/Codex/BYOK)에
// Hephaestus 의 빌더 에이전트 정의(agents/10|20|30 + 캐논 AGENTS.md)를 시스템 프롬프트로 얹어
// 실제 Agentlas 패키지를 워크스페이스 폴더에 생성하게 한다.
//
// 빌더 에이전트 정의는 번들된 Hephaestus 폴더에서 "런타임에 읽는다" — 데스크탑에 프롬프트를
// 복제하지 않으므로 엔진 업데이트와 자동으로 동기화되고, 데스크탑↔엔진 연결은 이 파일에만 산다.
import fs from "node:fs";
import path from "node:path";
import { pickActiveRunner } from "../mcp/client";
import { wrapSystemPrompt } from "../runtime/runner";
import type { RuntimeLocale } from "../runtime/status-i18n";
import type { HephaestusBuildEvent, HephaestusBuildRequest } from "../../shared/types";
import { hephaestusRoot } from "./engine";
import { securityScan } from "./commands";

export type BuildSink = (ev: HephaestusBuildEvent) => void;

const MODE_AGENT: Record<NonNullable<HephaestusBuildRequest["mode"]>, string> = {
  single: "agents/10-single-agent-builder/agent.md",
  team: "agents/20-multi-agent-team-builder/agent.md",
  package: "agents/30-agentlas-packager/agent.md",
};

function readIf(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** 빌더 시스템 프롬프트 조립: 캐논 AGENTS.md + (모드 빌더 또는 mode-map + 3 빌더) + 출력 지침. */
function composeBuilderPrompt(root: string, req: HephaestusBuildRequest): string {
  const parts: string[] = [];
  const canonical = readIf(root, "AGENTS.md");
  if (canonical) parts.push("# Hephaestus Canonical Core (AGENTS.md)\n", canonical, "\n");

  if (req.mode) {
    const agent = readIf(root, MODE_AGENT[req.mode]);
    if (agent) parts.push(`# Active Builder (${req.mode})\n`, agent, "\n");
  } else {
    // 모드 미지정 — mode-map + 3 빌더 헤더를 주고 엔진의 mode-classification 에 위임.
    const map = readIf(root, ".agentlas/mode-map.json");
    if (map) parts.push("# Mode Map (.agentlas/mode-map.json)\n", "```json\n" + map + "\n```\n");
    for (const rel of Object.values(MODE_AGENT)) {
      const a = readIf(root, rel);
      if (a) parts.push(`# Builder: ${rel}\n`, a, "\n");
    }
  }

  parts.push(
    [
      "# Desktop Build Task",
      "",
      "You are running inside the Agentlas Desktop app's Build menu. Your working directory IS the",
      "target workspace. Produce a COMPLETE, installable Agentlas package as real files on disk in the",
      "current working directory (use your file-write and shell tools — do not just describe).",
      "",
      "Rules:",
      "- Follow the Hephaestus builder discipline above (interview/research gate, contracts, adapters,",
      "  verification). Keep runtime-specific files as thin adapters over the canonical core.",
      "- Write every required file (AGENTS.md, agent.md or agents/*/agent.md, agentlas.json, .agentlas/*,",
      "  runtime adapters, scripts/verify-package.sh, docs/*).",
      "- When finished, print a final summary line beginning with 'BUILD_COMPLETE:' followed by the",
      "  package root folder name you created.",
      "- Do not embed any reference to the desktop app inside the generated package — it must be a clean,",
      "  portable Agentlas package.",
    ].join("\n"),
  );
  return parts.join("\n");
}

/**
 * 빌더 실행. 활성 런타임으로 Hephaestus 빌더 에이전트를 구동하고 진행을 sink 로 스트리밍한다.
 */
export async function runHephaestusBuild(
  runId: string,
  req: HephaestusBuildRequest,
  sink: BuildSink,
  signal: AbortSignal,
  locale: RuntimeLocale = "ko",
): Promise<void> {
  const root = hephaestusRoot();
  if (!root) {
    sink({ runId, kind: "error", text: "Hephaestus 엔진 번들을 찾을 수 없습니다." });
    return;
  }
  if (!req.workspace || !fs.existsSync(req.workspace)) {
    sink({ runId, kind: "error", text: "빌드 워크스페이스 폴더가 유효하지 않습니다." });
    return;
  }

  const picked = await pickActiveRunner();
  if (!picked) {
    sink({
      runId,
      kind: "error",
      text: "활성 런타임이 없습니다. 설정에서 Claude Code/Codex/Gemini 또는 API 키(BYOK)를 먼저 구성하세요.",
    });
    return;
  }

  const agentPrompt = composeBuilderPrompt(root, req);
  const systemPrompt = wrapSystemPrompt(agentPrompt, locale, "full", req.request, true);

  sink({ runId, kind: "stage", stage: "build", text: `빌더 시작 (${picked.label})` });

  try {
    const result = await picked.runner(
      {
        systemPrompt,
        history: [],
        userPrompt: req.request,
        backendLabel: picked.label,
        permission: "full",
        cwd: req.workspace,
        signal,
        locale,
      },
      {
        onPartial: (chunk) => sink({ runId, kind: "partial", text: chunk }),
        onStatus: (status) => sink({ runId, kind: "log", text: status }),
        onTool: (name, args, toolResult, _id, isError) =>
          sink({
            runId,
            kind: "stage",
            stage: name,
            text: isError ? `도구 오류: ${name}` : name + (args ? ` ${args.slice(0, 120)}` : ""),
          }),
      },
    );

    // 빌드 후 정적 보안 스캔(워크스페이스) — 결과는 done 이벤트에 첨부.
    sink({ runId, kind: "stage", stage: "security", text: "정적 보안 스캔" });
    let scan: unknown = null;
    if (!signal.aborted) {
      const scanRes = await securityScan(req.workspace, { signal, timeoutMs: 120_000 }).catch(() => null);
      scan = scanRes?.json ?? null;
    }

    sink({
      runId,
      kind: "done",
      text: result.text,
      result: { workspace: req.workspace, securityScan: scan },
    });
  } catch (e) {
    if (signal.aborted) {
      sink({ runId, kind: "error", text: "빌드 취소됨" });
    } else {
      sink({ runId, kind: "error", text: `빌드 실패: ${(e as Error).message}` });
    }
  }
}
