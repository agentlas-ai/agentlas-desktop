// 온보딩이 끝날 때 오케스트레이터·워커를 처음 정한다(오너 2026-10-06).
//
// "온보딩에서 설정한 모델들로 첨에 자동으로 오케스트레이터 워커 설정되게 해줘
//  안붙이고 agentlas api쓰면 오케랑 워커도 agentlas api"
//
// 그 전에는 앱이 처음 감지할 때 목록의 첫 런타임 하나를 오케스트레이터로만 앉혔다. 설치만
// 되고 로그인하지 않은 CLI도 그 자리에 앉았고, 온보딩에서 무엇을 연결했는지는 역할에 닿지
// 않았다. 이제 온보딩 AI 단계의 세 칸을 화면 순서대로 읽는다: 로그인한 구독 CLI(칩 순서) →
// 쓸 수 있는 Agentlas → 로컬 모델. CLI가 있으면 그것들이 풀이고, 없으면 그다음 칸 하나다.
// 오케스트레이터와 워커는 같은 풀을 명시적으로 받는다. 사람이 역할을 한 번이라도 직접
// 고른 뒤에는(origin "user") 온보딩이 다시 덮지 않는다.
import { CONNECTABLE_RUNTIMES, FIRST_RUN_LOCAL_MODEL_KINDS, agentlasServingReady, type ConnectableRuntime } from "../../shared/runtime-connect";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { getModelRolesOrigin, hasModelRoleMembers, setModelRoleMembers } from "../store/model-roles";
import { clearDetectCache, detectRuntimes, setActiveRuntime } from "./detect";
import { probeAllRuntimeAuth } from "./runtime-connect";

export interface FirstRunRoleSeed {
  seeded: boolean;
  /** 채우지 않은 이유 — 화면 문구가 아니라 기계 표식. */
  reason: "owner-chosen" | "nothing-connected" | null;
  pool: RuntimeSelection[];
}

function selectionOf(runtime: RuntimeStatus): RuntimeSelection {
  return {
    kind: runtime.kind,
    backend: runtime.backend,
    source: runtime.source,
    ...(runtime.acpAgentId ? { acpAgentId: runtime.acpAgentId } : {}),
    ...(runtime.label ? { label: runtime.label } : {}),
    model: runtime.model ?? undefined,
    longContext: runtime.longContextEnabled,
    effort: runtime.effort ?? undefined,
  };
}

/** 순서 있는 풀(첫 줄이 1순위). 비면 온보딩에서 연결한 것이 없다. */
export function firstRunRolePool(input: {
  list: RuntimeStatus[];
  signedIn: ReadonlySet<ConnectableRuntime>;
  agentlasReady: boolean;
}): RuntimeSelection[] {
  const clis = CONNECTABLE_RUNTIMES.flatMap((kind) => {
    if (!input.signedIn.has(kind)) return [];
    const runtime = input.list.find((row) => row.kind === kind);
    return runtime ? [selectionOf(runtime)] : [];
  });
  if (clis.length > 0) return clis;
  const agentlas = input.list.find((row) => row.kind === "agentlas");
  if (input.agentlasReady && agentlas) return [selectionOf(agentlas)];
  const local = input.list.find((row) => FIRST_RUN_LOCAL_MODEL_KINDS.has(row.kind)
    && row.localObservation?.state !== "pending"
    && Boolean(row.model || (row.availableModels?.length ?? 0) > 0));
  return local ? [selectionOf({ ...local, model: local.model ?? local.availableModels?.[0] ?? null })] : [];
}

export async function seedFirstRunRoles(): Promise<FirstRunRoleSeed> {
  const origin = getModelRolesOrigin();
  // A pool written before this record existed was written by a person.
  if (origin === "user" || (origin === null && hasModelRoleMembers())) {
    return { seeded: false, reason: "owner-chosen", pool: [] };
  }
  // Loaded late, as detect.ts loads auth: billing pulls auth, and auth pulls windows and menus.
  const { getBillingCredits } = await import("../billing");
  clearDetectCache();
  const [list, probes, credits] = await Promise.all([
    detectRuntimes(true),
    probeAllRuntimeAuth(false),
    getBillingCredits().catch(() => null),
  ]);
  const signedIn = new Set(probes.filter((probe) => probe.state === "signed-in").map((probe) => probe.kind));
  const pool = firstRunRolePool({ list, signedIn, agentlasReady: agentlasServingReady(credits) });
  if (pool.length === 0) return { seeded: false, reason: "nothing-connected", pool };
  setModelRoleMembers("orchestrator", pool.map((selection) => ({ ...selection, role: "orchestrator", inherit: false })), "first-run");
  setModelRoleMembers("worker", pool.map((selection) => ({ ...selection, role: "worker", inherit: false })), "first-run");
  // active_runtime is the orchestrator compatibility mirror; it still names the detect-time pick.
  await setActiveRuntime({ ...pool[0], role: "orchestrator", inherit: false }, "first-run");
  return { seeded: true, reason: null, pool };
}
