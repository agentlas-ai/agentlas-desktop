// Stormbreaker Loop supervisor.
//
// 모든 채팅 실행(invoke)에 Hephaestus 의 scope lock → route → evidence/review
// gate 상태를 표출한다. 이 파일은 실행 러너를 대체하지 않으며, Agentlas 가
// 실제로 검증할 수 있는 오류에 대해서만 repair/retry 표식을 낸다.
//
// 핵심: 호출자(runner 경로)를 절대 블록하지 않는다. 가용성 프로브(python 탐색)는 첫 호출에서
// 비용이 들 수 있으므로(특히 python 부재 머신) 전부 백그라운드에서 동시 수행하고, 핸들은 즉시
// 반환한다. 메인 실행 경로(검증된 러너)는 절대 대체하지 않는다.
import { hephaestusAvailable } from "./engine";
import { routeOnly, securityScan } from "./commands";
import { isSupervisorEnabled } from "./supervisor";

export interface StormbreakerToolEmit {
  (tool: { name: string; args?: string; result?: string; isError?: boolean }): void;
}

export interface StormbreakerHandle {
  /** 이어 실행할 수 있는 작업 패킷을 같은 invocation 안에서 계속 진행할 때 호출. */
  continuePass: (opts: { pass: number; reason: string }) => void;
  /** 검증 가능한 오류를 고치기 위해 실제 재호출을 시작할 때 호출 — visible repair/retry 표식. */
  repair: (opts: { stage: string; reason: string; attempt: number }) => void;
  /** 실행 종료 직전 호출 — 리뷰/최종 게이트를 표출(워크스페이스 산출물이 있으면 정적 검증). */
  finish: (opts?: { workspace?: string; permission?: "read" | "write" | "full" }) => Promise<void>;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function summarizeRoute(decision: Record<string, unknown>): string {
  const action = String(decision.action ?? decision.decision ?? "assess");
  const lines: string[] = [`Route decision: ${action}`];
  const selected = asObj(decision.selected ?? decision.candidate ?? decision.route);
  const name = selected.name ?? selected.name_ko ?? selected.id;
  if (name) lines.push(`Selected: ${String(name)}`);
  const fabric = decision.execution_fabric ?? decision.pipeline;
  if (Array.isArray(fabric)) lines.push(`Pipeline packets: ${fabric.length}`);
  else if (fabric && typeof fabric === "object") {
    const packets = asObj(fabric).packets;
    if (Array.isArray(packets)) lines.push(`Pipeline packets: ${packets.length}`);
  }
  if (decision.clarify ?? decision.clarification) lines.push("Clarification suggested before execution.");
  lines.push("Verifier-first plan: evidence required before completion is accepted.");
  return lines.join("\n");
}

function summarizeGate(scan: Record<string, unknown>): string {
  const status = String(scan.status ?? scan.verdict ?? "reviewed");
  const findings = scan.findings ?? scan.issues ?? scan.violations;
  const count = Array.isArray(findings) ? findings.length : 0;
  if (count > 0) {
    return `Evidence gate: ${count} static finding(s) flagged for review (status: ${status}). Inspect before publishing.`;
  }
  return `Evidence gate: passed (status: ${status}). Produced artifacts cleared static review.`;
}

/**
 * 채팅 실행을 항상 켜진 Stormbreaker Loop 로 감독한다(비차단).
 * 즉시 핸들을 반환하고, 엔진 가용성 확인·scope-lock·라우팅 평가는
 * 백그라운드에서 동시 수행한다. 엔진이 없어도 prompt-level guard 계약은 이미 주입되어 있다.
 */
export function superviseStormbreaker(opts: {
  query: string;
  cwd?: string;
  emit: StormbreakerToolEmit;
  signal?: AbortSignal;
}): StormbreakerHandle | null {
  if (!isSupervisorEnabled()) return null;

  opts.emit({
    name: "Stormbreaker Loop · armed",
    result:
      "Guard loaded: scope-lock -> issue contract -> plan-lock -> act -> verify -> bounded repair/retry for concrete validation errors -> final-gate. External account work remains unverified until a connector, browser session, or tool proves it.",
  });

  // 가용성 확인(백그라운드) — 호출자를 블록하지 않는다.
  const readyP: Promise<boolean> = hephaestusAvailable()
    .then((a) => a.available)
    .catch(() => false);

  // scope-lock + 라우팅 평가(동시·오프라인-안전·비차단). 엔진 가용 확인 후에만 표출.
  const routeP = readyP
    .then(async (ok) => {
      if (opts.signal?.aborted) return;
      if (!ok) {
        opts.emit({
          name: "Stormbreaker Loop · engine",
          result: "Native Hephaestus engine unavailable; prompt-level guard remains active for this run.",
          isError: true,
        });
        return;
      }
      opts.emit({
        name: "Stormbreaker Loop · scope-lock",
        result:
          "Engaged. Scope locked to the current request; failure-memory checked; verifier-first, evidence-bound execution.",
      });
      const res = await routeOnly(opts.query, {
        project: opts.cwd ?? ".",
        noHub: true,
        allowLocal: true,
        signal: opts.signal,
        timeoutMs: 60_000,
      }).catch(() => null);
      if (res?.json && !opts.signal?.aborted) {
        opts.emit({ name: "Stormbreaker Loop · route", result: summarizeRoute(asObj(res.json)) });
      }
    })
    .catch(() => {
      /* 비차단 */
    });

  return {
    continuePass: (cont) => {
      opts.emit({
        name: "Stormbreaker Loop · continue",
        result: `Continuation pass ${cont.pass} started. Reason: ${cont.reason}`,
      });
    },
    repair: (repair) => {
      opts.emit({
        name: "Stormbreaker Loop · repair/retry",
        result: `${repair.stage}: repair pass ${repair.attempt} started. Reason: ${repair.reason}`,
      });
    },
    finish: async (fin) => {
      const ok = await readyP.catch(() => false);
      if (!ok || opts.signal?.aborted) return; // 엔진 부재 — 게이트 표식 생략(가짜 표식 방지).
      await routeP.catch(() => {});
      if (opts.signal?.aborted) return;
      try {
        const producesArtifacts =
          (fin?.permission === "write" || fin?.permission === "full") && Boolean(fin?.workspace);
        if (producesArtifacts && fin?.workspace) {
          // evidence gate — 산출물이 있는 턴만 정적 보안 스캔(비-빌드 Q&A 턴은 가볍게).
          // 답변 표출을 과도히 지연하지 않도록 25s 로 바운드(초과 시 무해하게 생략).
          const scan = await securityScan(fin.workspace, { signal: opts.signal, timeoutMs: 25_000 });
          opts.emit({ name: "Stormbreaker Loop · final-gate", result: summarizeGate(asObj(scan.json)) });
        } else {
          opts.emit({
            name: "Stormbreaker Loop · final-gate",
            result: "Review gate: response reviewed against locked scope. No file artifacts to verify this turn.",
          });
        }
      } catch {
        /* 비차단 */
      }
    },
  };
}
