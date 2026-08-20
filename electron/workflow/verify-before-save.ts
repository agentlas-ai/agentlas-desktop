/**
 * 저장하기 **전에** 돌려 본다 — 그리고 안 되면 조용히 고친다.
 *
 * 왜 필요한가 (2026-08-20 실측):
 * 빌더가 만든 그래프의 검사는 **모양만** 본다(shared/graph-blueprint.ts 의 지적 55종).
 * 스크립트는 모델이 써서 **한 번도 돌아 본 적 없이** 저장된다. 그래서 새로 만든 환율
 * 자동화의 첫 단계가 자료원에서 HTTP 403 을 받고 죽었고, 사람은 그것을 **며칠 뒤 예약
 * 실행에서** 알게 된다. 그때는 고칠 사람이 그 자리에 없다.
 *
 * 공개 벤치마크도 같은 것을 말한다(Chat2Workflow 2026): 형식 통과율과 실제 실행 성공률의
 * 격차가 모든 모델에서 15~25%p 다. **문법적으로 legal 한 워크플로가 실행을 보장하지 않는다.**
 * 즉 모양 검사만 늘리는 것으로는 이 격차가 안 줄어든다.
 *
 * ★알림은 산출물이 아니라 최후 수단이다(오너 결정 2026-08-19). 이 파일의 목표는
 *   "실패를 잘 보고하기"가 아니라 **저장되는 물건이 도는 것**이다. 그래서:
 *     1) 싼 단계만 실제로 돌린다 — code 단계는 실측 0.0~0.1초다(모델 부르는 단계는 40초+).
 *        오늘 나온 결함은 전부 그 싼 쪽에서 나왔다.
 *     2) 실패하면 **한 번 다시 짜서 다시 돌린다**(자가 수리 연구: 이득의 대부분이 첫 2~3회).
 *     3) 그래도 안 되면 **에러코드가 아니라 사람 말로** 무엇이 없는지 말한다.
 *
 * ★바깥을 바꾸는 단계는 돌리지 않는다 — 만들다가 메일이 나가면 안 된다.
 */

import type { WorkflowGraph, WorkflowNode } from "../../shared/types";

export type PreSaveStepState = "ran" | "repaired" | "blocked" | "skipped";

export interface PreSaveStepResult {
  nodeId: string;
  label: string;
  state: PreSaveStepState;
  /** blocked 일 때만 — 사람이 읽는 한 문장. 에러코드가 아니다. */
  cause?: string;
  /** repaired 일 때만 — 이 실행에서 통한 새 스크립트. 부르는 쪽이 저장 여부를 정한다. */
  repairedCode?: string;
  /** skipped 일 때만 — 왜 못 쟀는지. 못 잰 것을 통과로 세지 않는다. */
  skippedBecause?: string;
}

export interface PreSaveVerification {
  /** 돌려 본 것 중 막힌 것이 없다. skipped 는 실패가 아니다(못 잰 것이다). */
  ok: boolean;
  steps: PreSaveStepResult[];
}

function str(config: Record<string, unknown> | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 실패에서 **사람이 읽을 한 줄**을 앞으로 꺼낸다.
 *
 * ★여기서 원인을 **분류하지 않는다.** 첫 판은 403·429·타임아웃… 을 정규식으로 갈라
 *   각각 한국어 문장을 붙였다. 그건 이 저장소가 이미 버린 방식이다 — 오류는 무한하고,
 *   단어장·정규식으로 판정하면 새 모양마다 구멍이 생기며 다국어에서 전멸한다.
 *   (오너 결정 2026-08-12: capability-widening content 판정 폐지, 같은 이유.)
 *
 *   그래서 하는 일은 **자르기**뿐이다: 트레이스백의 마지막 예외 줄이 사실이고, 그 위
 *   수십 줄은 인터프리터 내부 경로라 사람에게 정보가 없다. 사실을 앞에 세우고 나머지는
 *   뒤에 붙인다. "이게 무슨 뜻인지"를 사람 말로 옮기는 일은 이 파일이 아니라 복구
 *   서비스가 한다 — 코드는 사실만 모으고, 가능한 행동은 유한 목록으로 만들고, 문구는
 *   모델이 쓴다(automation-fix.ts 의 계약).
 */
export function humanCauseOf(rawFailure: string | null | undefined): string {
  const text = String(rawFailure ?? "").trim();
  if (!text) return "이 단계가 실행되지 않았습니다.";
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? text;
  if (lines.length <= 3 || !/^traceback/i.test(lines[0])) return text;
  return last;
}

/** 이 단계를 저장 전에 돌려 봐도 되는가. 바깥을 바꾸는 것은 절대 돌리지 않는다. */
function isCheapAndSafeToRun(node: WorkflowNode): boolean {
  if (node.type !== "code") return false;
  return str(node.config, "effect") !== "mutation";
}

/**
 * 저장 전 검증.
 *
 * `runCode` / `rewrite` 는 주입한다 — 이 파일이 커널의 실행기와 모델 호출에 직접 매이면
 * 시험할 수 없고, 터미널·데스크탑이 각자 다른 경로로 부르게 된다.
 */
export async function verifyGraphBeforeSave(
  graph: WorkflowGraph | null | undefined,
  deps: {
    runCode: (input: { code: string; lang: "python" | "js"; vars: Record<string, unknown> })
      => Promise<{ ok: boolean; reason?: string | null; result?: unknown; stdout?: string }>;
    rewrite?: (input: { instruction: string; lang: "python" | "js"; code: string; failure: string; varNames: string[] })
      => Promise<string | null>;
    /** 트리거가 주는 시작 값(있으면). 없으면 빈 값으로 둔다 — 그래프가 그렇게 안내한다면 그것이 정상이다. */
    initialVars?: Record<string, unknown>;
  },
): Promise<PreSaveVerification> {
  const steps: PreSaveStepResult[] = [];
  if (!graph || !Array.isArray(graph.nodes)) return { ok: true, steps };

  // 앞 단계가 만든 값을 뒤 단계에 넘긴다 — 실제 실행과 같은 순서라야 의미가 있다.
  const vars: Record<string, unknown> = { ...(deps.initialVars ?? {}) };

  for (const node of graph.nodes) {
    if (!isCheapAndSafeToRun(node)) continue;
    const code = str(node.config, "code");
    if (!code) {
      steps.push({
        nodeId: node.id,
        label: node.label || node.id,
        state: "skipped",
        skippedBecause: "이 단계에는 아직 스크립트가 없습니다.",
      });
      continue;
    }
    const lang = str(node.config, "codeLang") === "js" ? "js" : "python";

    let run = await deps.runCode({ code, lang, vars });
    let repairedCode: string | undefined;

    if (!run.ok && deps.rewrite) {
      const rewritten = await deps.rewrite({
        instruction: str(node.config, "note") || node.label || node.id,
        lang,
        code,
        failure: String(run.reason ?? ""),
        varNames: Object.keys(vars),
      });
      if (rewritten && rewritten.trim() && rewritten.trim() !== code.trim()) {
        const second = await deps.runCode({ code: rewritten, lang, vars });
        if (second.ok) {
          run = second;
          repairedCode = rewritten;
        }
      }
    }

    if (run.ok) {
      const produces = str(node.config, "produces");
      if (produces) vars[produces] = run.result ?? run.stdout ?? "";
      steps.push({
        nodeId: node.id,
        label: node.label || node.id,
        state: repairedCode ? "repaired" : "ran",
        ...(repairedCode ? { repairedCode } : {}),
      });
      continue;
    }

    steps.push({
      nodeId: node.id,
      label: node.label || node.id,
      state: "blocked",
      cause: humanCauseOf(run.reason),
    });
    /*
     * ★막힌 뒤로는 더 돌리지 않는다. 뒤 단계는 이 단계의 값을 기다리므로, 값 없이 돌리면
     *   "값이 없다"는 가짜 실패가 줄줄이 나온다 — 사람에게 에러 목록을 안기는 짓이다.
     */
    break;
  }

  return { ok: !steps.some((s) => s.state === "blocked"), steps };
}

/**
 * 사람에게 할 말. **에러코드는 절대 내보내지 않는다.**
 * 다 됐으면 조용하다 — 잘 된 것을 보고하는 것은 소음이다.
 */
export function renderPreSaveVerification(v: PreSaveVerification): string[] {
  const out: string[] = [];
  const repaired = v.steps.filter((s) => s.state === "repaired");
  const blocked = v.steps.filter((s) => s.state === "blocked");

  for (const step of repaired) out.push(`"${step.label}" 단계가 처음엔 안 돌아서 한 번 고쳤습니다.`);
  for (const step of blocked) out.push(`"${step.label}" 단계는 아직 안 됩니다 — ${step.cause}`);
  return out;
}

/**
 * 커널의 실행기·재작성기를 물려 준 기본 배선. 터미널·데스크탑이 **같은 것**을 쓴다 —
 * 각자 배선하면 두 벌이 되고, 그게 이 저장소가 반복해서 앓은 병이다.
 */
export async function verifyGraphBeforeSaveWithKernel(
  graph: WorkflowGraph | null | undefined,
  initialVars?: Record<string, unknown>,
): Promise<PreSaveVerification> {
  const { runCodeStep } = await import("./code-runner");
  const { rewriteFailedCodeStep } = await import("./run-graph");
  return verifyGraphBeforeSave(graph, {
    ...(initialVars ? { initialVars } : {}),
    runCode: async ({ code, lang, vars }) => {
      const run = await runCodeStep({
        code,
        lang,
        vars,
        // 저장 전 확인은 바깥을 바꾸지 않는다 — 위에서 mutation 단계를 이미 걸렀고,
        // 여기서 한 번 더 못박는다(두 겹이라야 다음 사람이 실수해도 메일이 안 나간다).
        effect: "read",
        timeoutSeconds: 45,
      });
      return { ok: run.ok, reason: run.reason ?? null, result: run.result, stdout: run.stdout };
    },
    rewrite: (input) => rewriteFailedCodeStep(input),
  });
}
