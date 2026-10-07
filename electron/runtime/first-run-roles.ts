// 온보딩이 끝날 때 오케스트레이터·워커를 처음 정한다(오너 2026-10-06).
//
// "온보딩에서 설정한 모델들로 첨에 자동으로 오케스트레이터 워커 설정되게 해줘
//  안붙이고 agentlas api쓰면 오케랑 워커도 agentlas api"
//
// 그 전에는 앱이 처음 감지할 때 목록의 첫 런타임 하나를 오케스트레이터로만 앉혔다. 설치만
// 되고 로그인하지 않은 CLI도 그 자리에 앉았고, 온보딩에서 무엇을 연결했는지는 역할에 닿지
// 않았다. 이제 온보딩 AI 단계의 세 칸을 화면 순서대로 읽는다: 로그인한 구독 CLI(칩 순서) →
// 명시적으로 선택한 API 모델 → 쓸 수 있는 Agentlas → 로컬 모델. CLI/API는 같은 풀이다.
// 오케스트레이터와 워커는 같은 풀을 명시적으로 받는다. 사람이 역할을 한 번이라도 직접
// 고른 뒤에는(origin "user") 온보딩이 다시 덮지 않는다.
import { CONNECTABLE_RUNTIMES, FIRST_RUN_LOCAL_MODEL_KINDS, agentlasServingReady, type ConnectableRuntime } from "../../shared/runtime-connect";
import { BYOK_BACKENDS_ALL, type ByokBackend } from "../../shared/models";
import { rememberRuntimeSelection } from "./selection-memory";
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
  const apis = input.list.filter((runtime) => runtime.kind === "byok"
    && runtime.credentialAccess?.status === "available" && Boolean(runtime.model?.trim()))
    .map((runtime) => selectionOf({ ...runtime, model: runtime.model!.trim() }));
  if (clis.length > 0 || apis.length > 0) return [...clis, ...apis];
  const agentlas = input.list.find((row) => row.kind === "agentlas");
  if (input.agentlasReady && agentlas) return [selectionOf(agentlas)];
  const local = input.list.find((row) => FIRST_RUN_LOCAL_MODEL_KINDS.has(row.kind)
    && row.localObservation?.state !== "pending"
    && Boolean(row.model || (row.availableModels?.length ?? 0) > 0));
  return local ? [selectionOf({ ...local, model: local.model ?? local.availableModels?.[0] ?? null })] : [];
}

export interface FirstRunApiChoice {
  backend: ByokBackend;
  model: string;
}

function readFirstRunApiChoice(raw: unknown): FirstRunApiChoice | undefined {
  if (raw === undefined) return undefined;
  const invalid = () => Object.assign(new Error("Invalid first-run API choice"), { code: "invalid-first-run-api-choice" });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== 2 || !keys.includes("backend") || !keys.includes("model")) throw invalid();
  const choice = raw as Record<string, unknown>;
  if (typeof choice.backend !== "string" || !(BYOK_BACKENDS_ALL as readonly string[]).includes(choice.backend)
    || typeof choice.model !== "string" || choice.model.length > 256) throw invalid();
  const model = choice.model.trim();
  if (!model || /[\s\x00-\x1f\x7f]/.test(model)) throw invalid();
  return { backend: choice.backend as ByokBackend, model };
}

function ownerHasRolePool(): boolean {
  const origin = getModelRolesOrigin();
  // A pool written before this record existed was written by a person.
  return origin === "user" || (origin !== "first-run" && hasModelRoleMembers());
}

/** IPC input is untrusted: only an exact provider/model choice can reach the seed. */
export async function seedFirstRunRoles(rawApiChoice?: unknown): Promise<FirstRunRoleSeed> {
  const apiChoice = readFirstRunApiChoice(rawApiChoice);
  if (ownerHasRolePool()) return { seeded: false, reason: "owner-chosen", pool: [] };
  // Loaded late, as detect.ts loads auth: billing pulls auth, and auth pulls windows and menus.
  const { getBillingCredits } = await import("../billing");
  if (ownerHasRolePool()) return { seeded: false, reason: "owner-chosen", pool: [] };
  clearDetectCache();
  const [detected, probes, credits] = await Promise.all([
    detectRuntimes(true),
    probeAllRuntimeAuth(false),
    getBillingCredits().catch(() => null),
  ]);
  // Both marked owner pools and legacy pools can appear while the probes await.
  if (ownerHasRolePool()) return { seeded: false, reason: "owner-chosen", pool: [] };
  const chosenRuntime = apiChoice ? detected.find(runtime => runtime.kind === "byok"
    && runtime.backend === apiChoice.backend && runtime.credentialAccess?.status === "available") : undefined;
  if (apiChoice && !chosenRuntime) {
    throw Object.assign(new Error("The selected API credential is unavailable"), { code: "first-run-api-unavailable" });
  }
  const list = chosenRuntime && apiChoice
    ? detected.map(runtime => runtime === chosenRuntime ? { ...runtime, model: apiChoice.model } : runtime)
    : detected;
  const signedIn = new Set(probes.filter((probe) => probe.state === "signed-in").map((probe) => probe.kind));
  const pool = firstRunRolePool({ list, signedIn, agentlasReady: agentlasServingReady(credits) });
  if (pool.length === 0) return { seeded: false, reason: "nothing-connected", pool };
  // No await between the final owner check, the saved API choice and both role writes.
  // The provider-scoped memory keeps a manual choice allocatable after /models fails.
  if (ownerHasRolePool()) return { seeded: false, reason: "owner-chosen", pool: [] };
  if (apiChoice && chosenRuntime) {
    rememberRuntimeSelection("byok", apiChoice.backend, apiChoice.model, Boolean(chosenRuntime.longContextEnabled));
  }
  setModelRoleMembers("orchestrator", pool.map((selection) => ({ ...selection, role: "orchestrator", inherit: false })), "first-run");
  setModelRoleMembers("worker", pool.map((selection) => ({ ...selection, role: "worker", inherit: false })), "first-run");
  // active_runtime is the orchestrator compatibility mirror; it still names the detect-time pick.
  await setActiveRuntime({ ...pool[0], role: "orchestrator", inherit: false }, "first-run");
  return { seeded: true, reason: null, pool };
}
