// 채팅에서 에이전트가 자동화를 거는 emitter — memory(## Memory Events) / delegate(## Delegate)와 동일 패턴.
// 사용자가 반복/스케줄 작업을 요청하면, 에이전트가 reply 끝에 "## Automation" 블록을 넣는다.
// client.ts가 이 블록을 파싱해 현재 chat의 타깃(firm/agent)으로 자동화를 등록하고 블록은 사용자에게서 가린다.
//
// v33: 모델이 (a) 구조화 스케줄({preset,time,tz} 또는 {cron,tz})과 (b) 선택적 ordered steps[]를
// 방출할 수 있다. steps가 있으면 stepsToGraph로 WorkflowGraph를 합성하고, 없으면 graph=null(오늘의
// 단일 프롬프트). 모델 생성 cron은 schedule.ts로 검증하고 파싱 실패는 표면화한다(조용히 드롭 X).
import { validateCron, compilePreset, type SchedulePreset } from "./store/schedule";
import type { ScheduleSpec, WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowNodeType } from "../shared/types";

export const AUTOMATION_HEADING = "## Automation";

/** 모델이 방출하는 구조화 스케줄. preset+time 또는 raw cron 둘 중 하나. */
export interface EmittedSchedule {
  preset?: SchedulePreset;
  time?: string; // "HH:MM"
  tz?: string; // IANA
  cron?: string;
  dow?: number | string;
  day?: number;
}

/** 모델이 방출하는 ordered step. 앱이 좌→우 레이아웃 + 변수 배선을 소유한다. */
export interface EmittedStep {
  kind: WorkflowNodeType | "trigger";
  /** 이 스텝의 안정적 id. deps가 참조. 없으면 인덱스 기반 `n{i}`. */
  id?: string;
  /** 이 스텝이 시작되려면 끝나야 하는 다른 스텝 id들 → 병렬/팬인 DAG를 만든다.
   *  여러 스텝이 같은 상류에 deps를 걸면 팬아웃(병렬), 한 스텝이 여러 deps면 팬인. */
  deps?: string[];
  /** agent 노드: 에이전트 slug/id. */
  ref?: string;
  /** tool 노드: MCP catalog id(예 "slack"). */
  catalog?: string;
  prompt?: string;
  /** 이 노드 출력을 담을 변수명. 하류 consumes가 참조. */
  produces?: string;
  /** 상류 produces 변수명(들). {{var}} 치환 + 데이터 엣지 유추. 팬인은 배열. */
  consumes?: string | string[];
  params?: Record<string, unknown>;
  /** trigger 노드: 레거시 토큰 또는 구조화 스케줄. */
  schedule?: string;
  action?: string;
  label?: string;
}

export interface ParsedAutomation {
  name: string;
  /** daily-HH:MM | weekday-HH:MM | weekly-<mon..sun>-HH:MM | monthly-<day>-HH:MM (레거시 미러) */
  schedule: string;
  /** 방출 JSON 에 schedule 칸이 실제로 있었는가 — false 면 schedule 은 폴백값이라 기존 저장값을 덮으면 안 된다. */
  scheduleEmitted?: boolean;
  prompt: string;
  /** 이 자동화를 실행할 에이전트(id/slug/표시명). 미지정이면 현재 챗 타깃.
   *  오케스트레이터 챗에서 만든 자동화가 항상 오케스트레이터에 묶여 매 실행
   *  라우팅 홉을 타던 문제의 해결(해석은 client.ts). */
  agent?: string;
  /** Agentlas Hub 에이전트 slug. 있으면 로컬 agent 해석 대신 Hub borrow 대상으로 실행. */
  hubAgent?: string;
  /** 구조화 스케줄 spec(있으면 schedule_json으로 저장, 레거시 토큰보다 우선). */
  scheduleSpec?: ScheduleSpec | null;
  /** IANA 타임존. */
  tz?: string;
  /** 방출된 ordered steps → 그래프 합성 소스. 없으면 단일 프롬프트. */
  steps?: EmittedStep[];
  /** steps로부터 합성한 그래프(없으면 null). */
  graph?: WorkflowGraph | null;
}

export interface ParseAutomationsResult {
  automations: ParsedAutomation[];
  cleanedText: string;
  /** 검증 실패 등 — 조용히 드롭하지 않고 표면화(설계 §2.5). */
  errors: string[];
}

// 시스템 프롬프트에 동봉 — 에이전트가 언제/어떻게 자동화를 만들지 알려준다.
export const AUTOMATION_PROTOCOL = [
  "## Setting up automations",
  "",
  "If the user wants something RECURRING or SCHEDULED (every day, each morning, weekly, monthly…),",
  "register it as an automation that re-runs YOU on that schedule. End your reply with exactly this",
  "block (omit it entirely otherwise):",
  "",
  "CRITICAL: This block is the ONLY way to schedule recurring work in Agentlas. It registers the job",
  "in the Agentlas Automation tab where the user can see, edit, pause and delete it. Do NOT create",
  "OS-level schedulers instead — never write launchd/launchctl plists, cron jobs, systemd timers, or",
  "any system daemon, and never call a devops/automation skill to do so. Those are invisible to the",
  "user and unmanageable from the app. Always use THIS block.",
  "",
  "Before the block, always write at least one concise user-visible sentence about what you are setting up.",
  "Do not make the JSON block the only assistant content; the visible sentence is what the live chat stream shows.",
  "",
  AUTOMATION_HEADING,
  "```json",
  '[ { "name": "<short name>",',
  '    "prompt": "<exactly what to do on each run>",',
  '    "agent": "<installed agent name/slug/id that should RUN this — set it whenever a specific agent (not you) owns the job; omit to run on yourself>",',
  '    "hubAgent": "<optional Agentlas Hub agent slug to RUN this without local install>",',
  '    "schedule": { "preset": "daily|weekday|weekly|monthly|hourly", "time": "09:00", "tz": "Asia/Seoul" } } ]',
  "```",
  "",
  'For irregular cadence use raw cron instead: "schedule": { "cron": "*/30 9-18 * * 1-5", "tz": "Asia/Seoul" }.',
  "",
  // ★반복 × 고정 페이로드는 시한폭탄이다. 실측 2026-08-19: 매시 정각 X 댓글
  // 자동화가 "exactly this text, unchanged"로 지어졌고, 첫 성공이 X의 중복
  // 콘텐츠 차단을 깨워 이후 모든 실행이 막혔다. 메일 스팸 필터·커뮤니티 도배
  // 제한·API rate limit 도 같은 계열이다 — 반복 게시물은 변형이 기본값이어야 한다.
  "RECURRING MUTATIONS MUST VARY. If each run posts, sends or publishes content, never pin the exact",
  "same text for every run — platforms reject duplicates (X blocks identical posts after the first",
  "success; mail and community platforms rate-limit or spam-filter repeats). Write the prompt so each",
  "run composes a fresh variant around the fixed facts (name, link, dates), e.g. \"write a short",
  "reply tailored to the post, always including <link> and <deadline>\" — not \"post exactly this text\".",
  "",
  // ★밖을 바꾸는 스텝은 어떤 도구로 바꾸는지 선언해야 한다. 선언이 없으면 강제도
  // 검사도 불가능하고(실측: 도구 미배선 런타임에서 12연속 거짓 성공), 선언이 있으면
  // 프록시가 노드별로 관문을 세운다.
  "MUTATING STEPS MUST NAME THEIR TOOL. Any step that changes the world outside the chat (posts,",
  "sends, edits files, browses) must say which tool family does it — a tool step with its catalog id,",
  "or an action step whose prompt names the concrete surface (browser, file, shell). A mutation with",
  "no named tool cannot be enforced or verified and will be judged unsupported.",
  "Registering is idempotent by name: emitting a block with the SAME \"name\" UPDATES the existing",
  "automation instead of creating a new one. When you refine a job you already registered, reuse the",
  "exact same name — NEVER register a second automation for the same job under a new name.",
  "STRONGLY prefer steps[] whenever the job has phases (gather → draft → check → publish → report):",
  "steps become an editable visual workflow the user can inspect; a single monolithic prompt is a",
  "last resort for genuinely one-step jobs.",
  "You MAY also break the run into steps that become a visual workflow graph. Steps can run in",
  "PARALLEL: give each step an `id`, and list `deps` (ids that must finish first). Multiple steps",
  "depending on the same upstream fan OUT (run in parallel); a step with several `deps` (or a",
  "`consumes` array) fans IN. Omit deps for a simple linear chain.",
  '  "steps": [ {"id":"trg","kind":"trigger","schedule":"daily-08:00"},',
  '             {"id":"kw","kind":"agent","prompt":"research keywords","produces":"keywords","deps":["trg"]},',
  '             {"id":"rA","kind":"agent","prompt":"deep-dive A","consumes":"keywords","produces":"a","deps":["kw"]},',
  '             {"id":"rB","kind":"agent","prompt":"deep-dive B","consumes":"keywords","produces":"b","deps":["kw"]},',
  '             {"id":"write","kind":"agent","prompt":"draft post from research","consumes":["a","b"],"deps":["rA","rB"]},',
  '             {"id":"post","kind":"output","action":"blog-post","consumes":"draft","deps":["write"]} ]',
  "  (rA and rB both depend on kw → they run as parallel branches; write fans them back in.)",
  "Legacy string schedules (\"daily-09:00\", \"weekly-mon-10:00\") are still accepted.",
  "Times are 24-hour local. Only emit this when the user actually asked for a recurring task — never for one-off work.",
].join("\n");

const DEFAULT_TZ_PLACEHOLDER = "";

/** 구조화 스케줄 → ScheduleSpec + 레거시 미러 토큰. cron 검증 실패는 errors로 표면화. */
function resolveSchedule(
  emitted: unknown,
  errors: string[],
): { spec: ScheduleSpec | null; token: string; tz: string } {
  const fallback = { spec: null as ScheduleSpec | null, token: "daily-09:00", tz: DEFAULT_TZ_PLACEHOLDER };

  // 레거시 문자열 형식.
  if (typeof emitted === "string") {
    return { spec: null, token: emitted.trim() || "daily-09:00", tz: DEFAULT_TZ_PLACEHOLDER };
  }
  if (!emitted || typeof emitted !== "object") return fallback;

  const o = emitted as EmittedSchedule;
  const tz = typeof o.tz === "string" && o.tz.trim() ? o.tz.trim() : DEFAULT_TZ_PLACEHOLDER;

  if (typeof o.cron === "string" && o.cron.trim()) {
    const cron = o.cron.trim();
    if (!validateCron(cron)) {
      errors.push(`Invalid cron expression rejected: "${cron}"`);
      return fallback;
    }
    // 레거시 스케줄러 미러 토큰은 cron이면 표현이 없으므로 hourly 근사 대신 schedule_json에 의존.
    return { spec: { kind: "cron", expr: cron, tz: tz || "UTC" }, token: `cron:${cron}`, tz };
  }

  const preset = (o.preset ?? "daily") as SchedulePreset;
  const time = typeof o.time === "string" && /^\d{1,2}:\d{2}$/.test(o.time) ? o.time : "09:00";
  const spec = compilePreset(preset, time, tz || "UTC", { dow: o.dow, day: o.day });
  if (!spec) {
    errors.push(`Could not compile schedule preset "${preset}" time "${time}"`);
    return fallback;
  }
  // 레거시 미러 토큰(기존 스케줄러가 schedule_json 없을 때 폴백으로 읽을 수 있게).
  const token = presetToLegacyToken(preset, time, o);
  return { spec, token, tz };
}

const DOW_TOKEN = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function presetToLegacyToken(preset: SchedulePreset, time: string, o: EmittedSchedule): string {
  switch (preset) {
    case "hourly":
      return "hourly";
    case "daily":
      return `daily-${time}`;
    case "weekday":
      return `weekday-${time}`;
    case "weekly": {
      let dow = 1;
      if (typeof o.dow === "number") dow = o.dow;
      else if (typeof o.dow === "string") {
        const idx = DOW_TOKEN.indexOf(o.dow.toLowerCase());
        if (idx >= 0) dow = idx;
      }
      return `weekly-${DOW_TOKEN[dow] ?? "mon"}-${time}`;
    }
    case "monthly":
      return `monthly-${o.day && o.day >= 1 ? o.day : 1}-${time}`;
    default:
      return `daily-${time}`;
  }
}

/**
 * ordered steps[] → WorkflowGraph. 결정적 좌→우 레이아웃(x=i*280, y=120), 연속 노드마다 엣지 1개.
 * consumes가 상류 produces를 참조하면 엣지에 변수명을 라벨(sourceHandle)로 스탬프("wire=data").
 */
/**
 * 등록 시점 구조 게이트 (정본 규칙 #3·#4) — 실측 2026-08-19의 두 치명 형태를 거절한다.
 * 판정은 구조뿐이다: 스케줄 유무, 80자 이상 고정 인용 스팬, 그래프 인접성.
 * 순수 함수로 둔 이유: client.ts 등록 루프와 테스트가 같은 코드 객체를 부른다 —
 * 하네스가 사본을 재면 사본만 초록이 된다(mock rot).
 */
export function automationRegistrationGateProblems(a: ParsedAutomation): string[] {
  const recurring = Boolean(a.scheduleSpec || (a.schedule && a.schedule.trim()));
  const graphNodes = Array.isArray(a.graph?.nodes) ? a.graph.nodes : [];
  const problems: string[] = [];
  for (const node of graphNodes) {
    if (String(node?.type) !== "action") continue;
    const cfg = (node?.config ?? {}) as Record<string, unknown>;
    const nodePrompt = typeof cfg.prompt === "string" ? cfg.prompt : "";
    if (recurring) {
      const quoted = nodePrompt.match(/"([^"]{80,})"|“([^”]{80,})”/);
      if (quoted) {
        problems.push(
          `node "${node.id}": a recurring schedule repeats an identical ${
            (quoted[1] ?? quoted[2] ?? "").length
          }-char quoted payload every run — platforms reject duplicates after the first success. Rewrite the prompt to compose a fresh variant around the fixed facts instead of pinning exact text.`,
        );
      }
    }
    const hasRef = typeof cfg.ref === "string" && cfg.ref.trim().length > 0;
    const hasCatalog = typeof cfg.catalog === "string" && cfg.catalog.trim().length > 0;
    const hasAdjacentTool = Array.isArray(a.graph?.edges) && a.graph.edges.some((edge) => {
      const other = edge?.source === node.id ? edge?.target : edge?.target === node.id ? edge?.source : null;
      return other != null && graphNodes.some((n2) => n2?.id === other && String(n2?.type) === "tool");
    });
    if (!hasRef && !hasCatalog && !hasAdjacentTool) {
      problems.push(
        `node "${node.id}": an action step with no executor — no agent ref, no tool catalog, no adjacent tool node. Name what performs this action.`,
      );
    }
  }
  return problems;
}

export function stepsToGraph(steps: EmittedStep[]): WorkflowGraph {
  const nodes: WorkflowNode[] = [];
  const producedBy: Record<string, string> = {}; // produces 변수명 → 만든 노드 id
  const idByIndex: string[] = [];

  // Pass 1: 노드 생성 + id/produces 기록(위치는 아래 레이어 레이아웃에서 결정).
  steps.forEach((step, i) => {
    const id = (step.id && step.id.trim()) || `n${i}`;
    idByIndex[i] = id;
    const nodeType: WorkflowNodeType = (step.kind === "trigger" ? "trigger" : step.kind) as WorkflowNodeType;
    const config: Record<string, unknown> = {};
    if (step.ref) config.ref = step.ref;
    if (step.catalog) config.catalog = step.catalog;
    if (step.prompt) config.prompt = step.prompt;
    if (step.produces) config.produces = step.produces;
    if (step.consumes) config.consumes = step.consumes;
    if (step.params) config.params = step.params;
    if (step.schedule) config.schedule = step.schedule;
    if (step.action) config.action = step.action;
    nodes.push({ id, type: nodeType, position: { x: 0, y: 0 }, config, label: step.label ?? defaultNodeLabel(nodeType, step) });
    if (step.produces) producedBy[step.produces] = id;
  });

  // Pass 2: 엣지 = 명시적 deps + consumes→produces 유추(dedupe). depsOf가 레이아웃 레벨을 결정.
  const edges: WorkflowEdge[] = [];
  const seen = new Set<string>();
  const depsOf: Record<string, Set<string>> = {};
  const addEdge = (source: string, target: string, varLabel?: string): void => {
    if (source === target) return;
    const key = `${source}->${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    (depsOf[target] ??= new Set<string>()).add(source);
    edges.push({ id: `e-${source}-${target}`, source, target, ...(varLabel ? { sourceHandle: varLabel } : {}) });
  };
  const validId = new Set(idByIndex);
  steps.forEach((step, i) => {
    const id = idByIndex[i];
    depsOf[id] ??= new Set<string>();
    for (const d of step.deps ?? []) if (validId.has(d)) addEdge(d, id);
    const consumed = Array.isArray(step.consumes) ? step.consumes : step.consumes ? [step.consumes] : [];
    for (const v of consumed) {
      const src = producedBy[v];
      if (src) addEdge(src, id, v);
    }
  });

  // Pass 3: 고아(inbound 없음·트리거 아님) → 트리거(없으면 첫 노드)에 연결(dangling 방지).
  const triggerIdx = steps.findIndex((s) => s.kind === "trigger");
  const triggerId = triggerIdx >= 0 ? idByIndex[triggerIdx] : null;
  for (const n of nodes) {
    if (n.type === "trigger") continue;
    if ((depsOf[n.id]?.size ?? 0) > 0) continue;
    const anchor = triggerId ?? nodes[0]?.id;
    if (anchor && anchor !== n.id) addEdge(anchor, n.id);
  }

  layoutLayered(nodes, depsOf);
  return { version: 1, nodes, edges };
}

/** 최장경로 레벨로 x(열), 레벨 내 스프레드로 y → 병렬 분기가 세로로 나란히 배치된다. */
function layoutLayered(nodes: WorkflowNode[], depsOf: Record<string, Set<string>>): void {
  const COL_W = 300;
  const ROW_H = 150;
  const CENTER_Y = 240;
  const level: Record<string, number> = {};
  const computing = new Set<string>();
  const lvl = (id: string): number => {
    if (level[id] != null) return level[id];
    if (computing.has(id)) return 0; // 사이클 가드
    computing.add(id);
    const ds = depsOf[id] ? Array.from(depsOf[id]) : [];
    const v = ds.length === 0 ? 0 : 1 + Math.max(...ds.map((d) => lvl(d)));
    computing.delete(id);
    level[id] = v;
    return v;
  };
  for (const n of nodes) lvl(n.id);
  const byLevel: Record<number, WorkflowNode[]> = {};
  for (const n of nodes) (byLevel[level[n.id]] ??= []).push(n);
  for (const key of Object.keys(byLevel)) {
    const L = Number(key);
    const col = byLevel[L];
    col.forEach((n, idx) => {
      n.position = { x: L * COL_W, y: (idx - (col.length - 1) / 2) * ROW_H + CENTER_Y };
    });
  }
}

function defaultNodeLabel(type: WorkflowNodeType, step: EmittedStep): string {
  switch (type) {
    case "trigger":
      return "Trigger";
    case "agent":
      return step.ref ? `Agent: ${step.ref}` : "Agent";
    case "tool":
      return step.catalog ? `Tool: ${step.catalog}` : "Tool";
    case "action":
      return step.action ? `Action: ${step.action}` : "Action";
    case "output":
      return "Output";
    case "condition":
      return "Condition";
    case "transform":
      return "Transform";
    default:
      return type;
  }
}

/**
 * graph_json이 null인 레거시 자동화를 위한 2노드 그래프 합성(trigger→executor).
 * 편집/렌더 표면이 항상 그래프를 가질 수 있게 즉석에서 만든다(저장하지 않음).
 */
export function synthesizeLegacyGraph(automation: {
  scheduleHuman: string;
  promptTemplate: string;
  targetType: "agent" | "firm" | "hub";
  targetId: string;
  targetVersion?: string;
}): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "n0",
        type: "trigger",
        position: { x: 0, y: 120 },
        config: { schedule: automation.scheduleHuman },
        label: "Trigger",
      },
      {
        id: "n1",
        type: "agent",
        position: { x: 280, y: 120 },
        config: {
          ref: automation.targetId,
          targetType: automation.targetType,
          prompt: automation.promptTemplate,
          ...(automation.targetType === "hub" && automation.targetVersion
            ? { targetVersion: automation.targetVersion }
            : {}),
        },
        label: automation.targetType === "firm" ? "Firm" : automation.targetType === "hub" ? "Hub Agent" : "Agent",
      },
    ],
    edges: [{ id: "e0-1", source: "n0", target: "n1" }],
  };
}

export function parseAutomations(text: string): ParseAutomationsResult {
  const idx = text.lastIndexOf(AUTOMATION_HEADING);
  if (idx < 0) return { automations: [], cleanedText: text.trim(), errors: [] };

  const after = text.slice(idx + AUTOMATION_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  const errors: string[] = [];
  let automations: ParsedAutomation[] = [];

  if (fence) {
    try {
      const raw = JSON.parse(fence[1].trim());
      // 자동화 세션 편집 계약(client.ts)은 "name + 전체 graph" **단일 객체**를 방출시킨다.
      // 배열만 받으면 그 계약의 방출이 통째로 버려진다 — 객체도 1원소 배열로 받는다.
      const data = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : null;
      if (data) {
        automations = data
          .map((d): ParsedAutomation | null => {
            if (!d || typeof d !== "object") {
              errors.push("Automation entry was not an object");
              return null;
            }
            const o = d as Record<string, unknown>;
            const name = typeof o.name === "string" ? o.name.trim() : "";
            const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
            const agent = typeof o.agent === "string" ? o.agent.trim() : "";
            const hubAgent = typeof o.hubAgent === "string" ? o.hubAgent.trim() : "";

            const scheduleEmitted = o.schedule !== undefined && o.schedule !== null;
            const { spec, token, tz } = resolveSchedule(o.schedule, errors);

            // steps[] → 그래프 합성.
            let steps: EmittedStep[] | undefined;
            let graph: WorkflowGraph | null = null;
            // 세션 편집 계약은 graph 를 통째로 방출한다 — steps 가 없으면 그 graph 를 그대로 쓴다.
            const g = o.graph as { nodes?: unknown; edges?: unknown } | undefined;
            const directGraph =
              g &&
              typeof g === "object" &&
              Array.isArray(g.nodes) &&
              g.nodes.length > 0 &&
              g.nodes.every(
                (n) => !!n && typeof n === "object" && typeof (n as { id?: unknown }).id === "string" && typeof (n as { type?: unknown }).type === "string",
              )
                ? (o.graph as WorkflowGraph)
                : null;
            if (o.graph !== undefined && !directGraph) {
              errors.push(`Automation "${name || "(unnamed)"}" carried a graph that is not a valid workflow graph`);
            }
            if (Array.isArray(o.steps) && o.steps.length > 0) {
              steps = (o.steps as unknown[])
                .filter((s): s is EmittedStep => !!s && typeof s === "object")
                .map((s) => s as EmittedStep);
              // trigger 스텝의 cron 검증(있으면).
              for (const s of steps) {
                if (s.kind === "trigger" && typeof s.schedule === "string" && s.schedule.startsWith("cron:")) {
                  const cron = s.schedule.slice(5).trim();
                  if (!validateCron(cron)) errors.push(`Invalid step cron rejected: "${cron}"`);
                }
              }
              graph = stepsToGraph(steps);
            }
            if (!graph && directGraph) graph = directGraph;

            // graph 를 실은 방출(세션 편집)은 prompt 가 없어도 유효하다 — 프롬프트는 그래프 노드가 갖는다.
            if (!name || (!prompt && !graph)) {
              errors.push(`Automation "${name || "(unnamed)"}" missing name/prompt`);
              return null;
            }

            return {
              name,
              schedule: token,
              scheduleEmitted,
              prompt,
              ...(agent ? { agent } : {}),
              ...(hubAgent ? { hubAgent } : {}),
              scheduleSpec: spec,
              tz,
              steps,
              graph,
            };
          })
          .filter((a): a is ParsedAutomation => a !== null);
      } else {
        errors.push("Automation block was neither a JSON array nor a JSON object");
      }
    } catch (err) {
      errors.push(`Automation JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    errors.push("Automation heading present but no JSON fence found");
  }

  let cut = text.length;
  if (fence && fence.index != null) {
    cut = idx + AUTOMATION_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = idx;
  }
  const cleanedText = (text.slice(0, idx) + text.slice(cut)).trim();
  return { automations, cleanedText, errors };
}
