import { redactSecrets } from "./secret-patterns";
import type {
  OneSurfaceManifestV1,
  OneSurfaceSemanticAction,
} from "./one-surface";

export const ONE_FOLLOWUPS_OPEN_FENCE = "<<agentlas-one-followups>>";
export const ONE_FOLLOWUPS_CLOSE_FENCE = "<</agentlas-one-followups>>";

export const ONE_FRIENDLY_OUTCOMES = [
  "created",
  "updated",
  "analyzed",
  "generated",
  "connected",
  "configured",
  "scheduled",
  "published",
  "imported",
  "repaired",
] as const;

export const ONE_FRIENDLY_RESOURCE_KINDS = [
  "agent",
  "team",
  "automation",
  "project",
  "document",
  "data",
  "media",
  "site",
  "integration",
  "workflow",
] as const;

export const ONE_FRIENDLY_CAPABILITIES = [
  "runnable",
  "inspectable",
  "editable",
  "reusable",
  "shareable",
] as const;

export type OneFriendlyOutcome = (typeof ONE_FRIENDLY_OUTCOMES)[number];
export type OneFriendlyResourceKind = (typeof ONE_FRIENDLY_RESOURCE_KINDS)[number];
export type OneFriendlyCapability = (typeof ONE_FRIENDLY_CAPABILITIES)[number];
export type OneFriendlyActionIntent =
  | "try_result"
  | "open_asset"
  | "refine_result"
  | "reuse_result"
  | "prepare_share";

export interface OneFriendlyFollowupPlanV1 {
  version: "1.0.0";
  outcome: OneFriendlyOutcome;
  resource: {
    kind: OneFriendlyResourceKind;
    label: string;
    capabilities: OneFriendlyCapability[];
  };
  actions: Array<{
    intent: OneFriendlyActionIntent;
    label: string;
    description?: string;
    instruction?: string;
  }>;
}

export interface OneFriendlyScenario {
  scenarioId: string;
  outcome: OneFriendlyOutcome;
  resourceKind: OneFriendlyResourceKind;
  capabilities: OneFriendlyCapability[];
  recommendedIntents: OneFriendlyActionIntent[];
}

const ACTION_CAPABILITY: Record<OneFriendlyActionIntent, OneFriendlyCapability> = {
  try_result: "runnable",
  open_asset: "inspectable",
  refine_result: "editable",
  reuse_result: "reusable",
  prepare_share: "shareable",
};
const RESOURCE_CAPABILITY_PROFILES: Record<OneFriendlyResourceKind, OneFriendlyCapability[]> = {
  agent: ["runnable", "inspectable", "editable", "reusable", "shareable"],
  team: ["runnable", "inspectable", "editable", "reusable", "shareable"],
  automation: ["runnable", "inspectable", "editable", "reusable"],
  project: ["inspectable", "editable", "shareable"],
  document: ["inspectable", "editable", "reusable", "shareable"],
  data: ["inspectable", "editable", "reusable", "shareable"],
  media: ["inspectable", "editable", "reusable", "shareable"],
  site: ["runnable", "inspectable", "editable", "shareable"],
  integration: ["runnable", "inspectable", "editable"],
  workflow: ["runnable", "inspectable", "editable", "reusable"],
};
const ACTION_PRIORITY: OneFriendlyActionIntent[] = [
  "try_result",
  "open_asset",
  "refine_result",
  "reuse_result",
  "prepare_share",
];
const SAFE_TEXT_RE = /(?:<|https?:\/\/|file:|javascript:|data:|\/(?:Users|home|private)\/|\b[A-Za-z]:\\)/i;
const ACTION_INTENTS = new Set<OneFriendlyActionIntent>(Object.keys(ACTION_CAPABILITY) as OneFriendlyActionIntent[]);
const OUTCOMES = new Set<string>(ONE_FRIENDLY_OUTCOMES);
const RESOURCE_KINDS = new Set<string>(ONE_FRIENDLY_RESOURCE_KINDS);
const CAPABILITIES = new Set<string>(ONE_FRIENDLY_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > limit || redactSecrets(normalized) !== normalized || SAFE_TEXT_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

function parsePlan(value: unknown): OneFriendlyFollowupPlanV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "outcome", "resource", "actions"])) return null;
  if (value.version !== "1.0.0" || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return null;
  if (!isRecord(value.resource) || !hasOnlyKeys(value.resource, ["kind", "label", "capabilities"])) return null;
  const resourceKind = value.resource.kind;
  const resourceLabel = safeText(value.resource.label, 120);
  const capabilities = value.resource.capabilities;
  if (typeof resourceKind !== "string" || !RESOURCE_KINDS.has(resourceKind) || !resourceLabel) return null;
  if (!Array.isArray(capabilities) || capabilities.length > ONE_FRIENDLY_CAPABILITIES.length
    || !capabilities.every((item) => typeof item === "string" && CAPABILITIES.has(item))) return null;
  const uniqueCapabilities = [...new Set(capabilities)] as OneFriendlyCapability[];
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 3) return null;
  const actions: OneFriendlyFollowupPlanV1["actions"] = [];
  for (const raw of value.actions) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["intent", "label", "description", "instruction"])) return null;
    if (typeof raw.intent !== "string" || !ACTION_INTENTS.has(raw.intent as OneFriendlyActionIntent)) return null;
    const intent = raw.intent as OneFriendlyActionIntent;
    if (!uniqueCapabilities.includes(ACTION_CAPABILITY[intent])) return null;
    const label = safeText(raw.label, 60);
    const description = raw.description == null ? undefined : safeText(raw.description, 220);
    const instruction = raw.instruction == null ? undefined : safeText(raw.instruction, 600);
    if (!label || (raw.description != null && !description) || (raw.instruction != null && !instruction)) return null;
    if (intent === "open_asset" && instruction) return null;
    if (intent !== "open_asset" && !instruction) return null;
    actions.push({ intent, label, ...(description ? { description } : {}), ...(instruction ? { instruction } : {}) });
  }
  if (new Set(actions.map((action) => action.intent)).size !== actions.length) return null;
  return {
    version: "1.0.0",
    outcome: value.outcome as OneFriendlyOutcome,
    resource: {
      kind: resourceKind as OneFriendlyResourceKind,
      label: resourceLabel,
      capabilities: uniqueCapabilities,
    },
    actions,
  };
}

export function parseOneFriendlyFollowups(text: string): {
  cleanedText: string;
  plan: OneFriendlyFollowupPlanV1 | null;
  error?: "missing-close" | "invalid-json" | "invalid-plan";
} {
  const start = text.indexOf(ONE_FOLLOWUPS_OPEN_FENCE);
  if (start < 0) return { cleanedText: text, plan: null };
  const end = text.indexOf(ONE_FOLLOWUPS_CLOSE_FENCE, start + ONE_FOLLOWUPS_OPEN_FENCE.length);
  if (end < 0) {
    return {
      cleanedText: text.slice(0, start).trim(),
      plan: null,
      error: "missing-close",
    };
  }
  const body = text.slice(start + ONE_FOLLOWUPS_OPEN_FENCE.length, end).trim();
  const cleanedText = `${text.slice(0, start)}${text.slice(end + ONE_FOLLOWUPS_CLOSE_FENCE.length)}`.trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return { cleanedText, plan: null, error: "invalid-json" };
  }
  const plan = parsePlan(decoded);
  return plan
    ? { cleanedText, plan }
    : { cleanedText, plan: null, error: "invalid-plan" };
}

function targetRefFor(kind: OneFriendlyResourceKind, taskId: string): string {
  if (["agent", "team", "automation", "project", "site"].includes(kind)) return `${kind}:library`;
  return taskId;
}

function boundedInstruction(intent: OneFriendlyActionIntent, instruction: string | undefined): string | undefined {
  if (!instruction) return undefined;
  if (intent === "prepare_share") {
    return `Prepare a reviewable sharing draft only. Do not send, publish, purchase, or contact anyone. ${instruction}`;
  }
  return `Continue in this same Task. Do not cause an external side effect without a new explicit approval. ${instruction}`;
}

export function applyOneFriendlyFollowups(
  surface: OneSurfaceManifestV1,
  plan: OneFriendlyFollowupPlanV1 | null | undefined,
): OneSurfaceManifestV1 {
  if (!plan || surface.surfaceState.value !== "ready") return surface;
  const actions = plan.actions.map<OneSurfaceSemanticAction>((action, index) => ({
    actionId: `action:followup:${index + 1}`,
    intent: action.intent,
    label: action.label,
    ...(action.description ? { description: action.description } : {}),
    ...(action.instruction ? { instruction: boundedInstruction(action.intent, action.instruction) } : {}),
    targetRef: targetRefFor(plan.resource.kind, surface.taskId),
    enabled: true,
  }));
  if (actions.length === 0) return surface;
  return {
    ...surface,
    primaryAction: actions[0],
    secondaryActions: actions.slice(1, 3) as OneSurfaceManifestV1["secondaryActions"],
  };
}

/** 10 outcomes × 10 resource families. Runtime uses capabilities, never these IDs. */
export function buildOneFriendlyScenarioMatrix(): OneFriendlyScenario[] {
  return ONE_FRIENDLY_OUTCOMES.flatMap((outcome) =>
    ONE_FRIENDLY_RESOURCE_KINDS.map((resourceKind) => {
      const capabilities = [...RESOURCE_CAPABILITY_PROFILES[resourceKind]];
      return {
        scenarioId: `${outcome}:${resourceKind}`,
        outcome,
        resourceKind,
        capabilities,
        recommendedIntents: ACTION_PRIORITY
          .filter((intent) => capabilities.includes(ACTION_CAPABILITY[intent]))
          .slice(0, 3),
      };
    }));
}

export function oneFriendlyFollowupProtocol(locale: "ko" | "en"): string {
  const example = locale === "ko"
    ? '{"version":"1.0.0","outcome":"created","resource":{"kind":"agent","label":"고객 응대 에이전트","capabilities":["runnable","inspectable","editable"]},"actions":[{"intent":"try_result","label":"직접 돌려보기","description":"실제 예시로 바로 확인해요.","instruction":"방금 만든 에이전트를 대표적인 고객 문의 예시 하나로 실행하고 결과를 검증해줘."},{"intent":"open_asset","label":"에이전트 보기","description":"Work의 에이전트 메뉴에서 확인해요."}]}'
    : '{"version":"1.0.0","outcome":"created","resource":{"kind":"agent","label":"Support agent","capabilities":["runnable","inspectable","editable"]},"actions":[{"intent":"try_result","label":"Try it now","description":"Run one realistic example.","instruction":"Run the agent on one representative support request and verify the result."},{"intent":"open_asset","label":"View agent","description":"Open it in the Work agent library."}]}';
  return locale === "ko"
    ? `완료된 결과에는 사용자가 다음 가치를 바로 얻을 실제 후속 행동 1~3개가 반드시 있어야 합니다. ${ONE_FOLLOWUPS_OPEN_FENCE} JSON ${ONE_FOLLOWUPS_CLOSE_FENCE} 블록을 Surface 바로 앞에 넣으세요. '원본 보기', '자세히 보기', '이대로 마무리'처럼 다른 화면이나 종료로 떠넘기는 행동은 만들지 마세요. 우선순위는 (1) 바로 써보기, (2) 지금 결과를 더 구체화하기, (3) 재사용·공유 준비입니다. 외부 전송·게시·구매는 실행하지 말고 준비 단계만 제안하세요. 가능한 intent는 try_result, open_asset, refine_result, reuse_result, prepare_share뿐입니다. open_asset은 실제로 생성되어 열 수 있는 자산이 있을 때만 쓰고 instruction을 넣지 마세요. 나머지는 같은 Task에서 실행할 구체적인 instruction을 넣으세요. 예: ${example}`
    : `Every completed result must include 1–3 real follow-up actions that give the user the next value immediately. Put a ${ONE_FOLLOWUPS_OPEN_FENCE} JSON ${ONE_FOLLOWUPS_CLOSE_FENCE} block immediately before the Surface. Never create deflective actions such as view original, see details, or finish here. Prioritize (1) trying the result now, (2) making the current result more concrete, and (3) preparing reuse or sharing. Never send, publish, purchase, or otherwise cause an external effect; offer preparation only. Allowed intents are try_result, open_asset, refine_result, reuse_result, and prepare_share. Use open_asset only for a real created asset and omit its instruction. Every other action needs a concrete instruction for the same Task. Example: ${example}`;
}
