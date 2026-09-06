// 자동화 플로우 — 챗이 만든 자동화를 노드 그래프로 렌더. P1: 읽기 전용 뷰어에서 편집 가능
// 캔버스로 승격. 편집 모드는 drag-move / drag-connect / 팔레트 추가 / config 편집 / 노드·엣지
// 삭제를 지원하고, updateGraph로 저장한다(설계 §4, P1). null-graph 자동화는 2노드 합성 그래프를
// 즉석에서 만들어 편집 시작점으로 제공한다.
//
// React Flow는 client-only이고 이 앱은 Next.js static export(file://)이므로 "use client" 필수.
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { humanSchedule } from "@shared/graph-blueprint";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  Automation,
  AutomationGraphTerminalCloseCandidate,
  AutomationGraphTerminalCloseInput,
  AutomationGraphTerminalCloseReceipt,
  RuntimeSelection,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeRunState,
} from "@/lib/types";
import { layoutGraph, needsLayout } from "@shared/graph-layout";
import { validateWorkflow, type WorkflowIssue } from "@/lib/workflow-validate";
import { workflowNodeTypes, type NodeStrings, type WorkflowNodeData } from "@/components/automation/nodes";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { NODE_ACCENT } from "@/components/automation/nodes/nodeShared";
import { NodePalette, type PaletteNodeSeed } from "@/components/automation/NodePalette";
import { NodeConfigPanel } from "@/components/automation/NodeConfigPanel";
import { RunHistoryPanel } from "@/components/automation/RunHistoryPanel";
import { AutomationSessionPanel } from "@/components/automation/AutomationSessionPanel";
import {
  runtimeBackendForSelection,
  runtimeEngineLabel,
  runtimeModelFallbackLabel,
  runtimeProviderLabel,
} from "@/components/dashboard/RuntimeModelPicker";
import { IconBolt, IconClose, IconPaperclip, IconRefresh } from "@/components/Icon";
import { ConnectionsDialog } from "@/components/automation/ConnectionsDialog";

function runtimeSelectionPresentation(selection: RuntimeSelection | null | undefined, locale: string): {
  label: string;
  detail: string;
} {
  if (!selection) {
    return {
      label: locale === "en" ? "Role default" : "역할 기본값 사용",
      detail: locale === "en" ? "Worker pool priority + fallback at run time" : "실행 시 Worker 풀 우선순위 · fallback",
    };
  }
  const runtimeIdentity = {
    kind: selection.kind,
    backend: runtimeBackendForSelection(selection),
    label: undefined,
  } as const;
  const provider = runtimeProviderLabel(runtimeIdentity);
  const engine = runtimeEngineLabel(runtimeIdentity);
  const model = selection.model?.trim();
  const effort = selection.effort?.trim() || (locale === "en" ? "Default effort" : "기본 작업량");
  return {
    label: locale === "en" ? "Automation pin · overrides role default" : "자동화별 고정 · 역할 기본보다 우선",
    detail: `${provider} · ${engine} · ${model ?? runtimeModelFallbackLabel(selection.kind, locale === "en" ? "en" : "ko")} · ${locale === "en" ? "effort" : "작업량"} ${effort} · ${locale === "en" ? "fails closed; no cross-provider fallback" : "사용할 수 없으면 중단 · 다른 공급자로 바꾸지 않음"}`,
  };
}

function exactAutomationProjection(value: unknown, automationId: string): Automation | null {
  if (!value || typeof value !== "object") return null;
  return (value as { id?: unknown }).id === automationId ? value as Automation : null;
}

function sameWorkflowGraph(left: WorkflowGraph | null | undefined, right: WorkflowGraph | null | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

type TerminalCloseRunSnapshot = Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["automations"]["latestRun"]>> & {
  occurrenceId?: string;
  graphDigest?: string;
  checkpointDigest?: string;
  checkpointUpdatedAt?: string;
  inFlightNodeIds?: string[];
  ambiguousNodeIds?: string[];
  completedEffectNodeIds?: string[];
};

type TerminalCloseInput = AutomationGraphTerminalCloseInput;
type TerminalCloseReceipt = AutomationGraphTerminalCloseReceipt;
type TerminalCloseCandidate = AutomationGraphTerminalCloseCandidate;

/** 좌/우 패널 접힘 상태 — 화면을 다시 열어도 사용자가 정한 레이아웃을 유지한다. */
const PANEL_STATE_KEY = "agentlas.automation.flow.panels";

/**
 * 캔버스를 맞추는 규칙 — **한 벌만 둔다.**
 * 세 곳(마운트·패널 토글·노드 추가)이 각자 옵션을 들고 있어, 마운트에서 하한을 걸어도
 * 뒤이은 호출이 하한 없이 덮어써 노드가 글자를 못 읽을 배율까지 줄어들었다(실사용 실측).
 * minZoom: 넓은 그래프는 다 보여주려 하지 말고, 읽을 수 있는 크기를 지키고 밀어서 본다.
 */
const FIT_VIEW = { padding: 0.16, maxZoom: 1, minZoom: 0.62 } as const;

export default function AutomationFlowWrapper() {
  return (
    <Suspense fallback={null}>
      <ReactFlowProvider>
        <AutomationFlowPage />
      </ReactFlowProvider>
    </Suspense>
  );
}

/** graph_json이 null인 레거시 자동화용 2노드 그래프 즉석 합성(백엔드 synthesizeLegacyGraph 미러). */
function synthesizeLegacyGraph(a: Automation): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "n0",
        type: "trigger",
        position: { x: 0, y: 120 },
        // scheduleSpec을 반드시 같이 실어야 한다. 폼으로 만든 자동화는 graph_json이 null이라
        // 여기서 시드되는데, cron/once/manual/interval 스케줄의 scheduleHuman 토큰은 "spec"이라
        // specFromLegacyToken이 복원하지 못한다(NodeConfigPanel §112). 그러면 ScheduleBuilder가
        // value=null로 마운트해 daily-09:00 기본값을 즉시 방출하고, 트리거 노드를 클릭만 해도
        // "*/30 9-18 * * 1-5" 같은 스케줄이 저장 시 하루 1회 09:00으로 조용히 덮어써졌다.
        config: { schedule: a.scheduleHuman, ...(a.scheduleSpec ? { scheduleSpec: a.scheduleSpec } : {}) },
        label: "Trigger",
      },
      {
        id: "n1",
        type: "agent",
        position: { x: 280, y: 120 },
        config: {
          ref: a.targetId,
          targetType: a.targetType,
          prompt: a.promptTemplate,
          ...(a.targetType === "hub" && a.targetVersion ? { targetVersion: a.targetVersion } : {}),
        },
        label: a.targetType === "firm" ? "Firm" : a.targetType === "hub" ? "Hub Agent" : "Agent",
      },
    ],
    edges: [{ id: "e0-1", source: "n0", target: "n1" }],
  };
}

function AutomationFlowPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const router = useRouter();
  const { t, locale } = useT();

  const [automation, setAutomation] = useState<Automation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 켜기/끄기가 도는 동안 버튼을 잠근다(중복 클릭 방지 + 눌린 티).
  const [stopping, setStopping] = useState(false);
  const [toggling, setToggling] = useState(false);
  const togglingRef = useRef(false);
  /** 시작 값을 받아야 하는 그래프에서 사람에게 값을 묻는 상태. */
  const [inputPrompt, setInputPrompt] = useState<{ label: string; value: string; fresh: boolean } | null>(null);
  /** 이 그래프가 쓰는 것들을 한 창에서 정리한다(공급자 묶음별). */
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  /* ★이전 판 — 저장이 덮어쓰기뿐이라, 말로 고치다 한 번 잘못 저장하면 잘 돌던 그래프가
     되돌아갈 자리 없이 사라졌다. 목록은 열 때 한 번만 읽는다. */
  /* Hub에 올리기 — 메인 프로세스엔 처음부터 있었는데 누를 자리가 없었다. */
  const [publishing, setPublishing] = useState(false);
  /* 화면 조작 권한(이 실행본 기준). 문장이 아니라 버튼으로 안내한다. */
  const [cuaPerm, setCuaPerm] = useState<{ ok: boolean; missing: string[] } | null>(null);
  /* 최근 실행 시각 — 로그 줄에 병기. 없으면 어제의 실패가 지금 상태처럼 읽힌다(실측 혼선). */
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<Array<{ id: string; savedAt: string; note?: string; nodeCount: number }>>([]);
  const [restoring, setRestoring] = useState("");
  /** 켤 수 있는 상태인가. 버튼 이름이 이걸 그대로 말한다. */
  const [blockedByConnections, setBlockedByConnections] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // ★되돌아가는 연결(반복)의 상한은 **엣지에** 붙는다. 그런데 엣지를 고를 방법이 없어서,
  //   커널이 "되돌아가는 연결을 눌러 반복 횟수를 정하세요"라고 안내하는데 누를 것이 없었다.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** 저장 직후 하이드레이션 1회 스킵 — 캔버스 배치를 needsLayout이 덮어쓰지 못하게. */
  const skipNextHydrationRef = useRef(false);
  /** 하단 통합 패널의 공용 입력이 세션 대화 전송을 부르는 손잡이(임베드 세션이 채운다). */
  const sessionSendRef = useRef<((text: string, files?: File[], onAccepted?: () => void) => void) | null>(null);
  const [saving, setSaving] = useState(false);
  // 좌(세션 대화)·우(노드 검사 + 실행 기록) 패널 접기. 캔버스가 좁은 화면에서 가장 먼저
  // 희생되던 문제를 사용자가 직접 해소할 수 있게 한다. 선택은 로컬에 남는다.
  // 세션 대화는 접힌 채로 시작한다. 1440px 창에서 좌 300 + 우 320을 늘 펴 두면
  // 이 화면의 주인공인 캔버스가 절반도 못 갖고, 그래프가 축소돼 노드 글자가 작아진다.
  // 대화는 할 말이 생겼을 때 여는 것이고, 접기 탭은 그대로 보인다.
  // 사용자가 한 번이라도 편 뒤에는 그 선택이 저장돼 유지된다.
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PANEL_STATE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { left?: boolean; right?: boolean };
      if (typeof saved.left === "boolean") setLeftOpen(saved.left);
      if (typeof saved.right === "boolean") setRightOpen(saved.right);
    } catch {
      // 저장된 값이 깨졌으면 기본값(둘 다 열림)으로 둔다.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({ left: leftOpen, right: rightOpen }));
    } catch {
      // 저장 실패는 이 화면의 동작을 막지 않는다.
    }
  }, [leftOpen, rightOpen]);

  // 패널을 접었는데 그래프가 원래 자리에 그대로 있으면 넓어진 캔버스가 빈 여백으로 보인다.
  // 폭이 바뀐 다음 프레임에 다시 맞춘다.
  const { fitView } = useReactFlow();
  // 팔레트로 노드를 추가한 직후 한 번만 fitView — 커밋·측정이 끝난 뒤에 돈다.
  const pendingFitRef = useRef(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        fitView({ ...FIT_VIEW });
      } catch {
        // 캔버스가 아직 준비되지 않았으면 다음 상호작용에서 맞춰진다.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, leftOpen, rightOpen]);

  const [rfNodes, setRfNodes, onNodesChangeBase] = useNodesState<Node<WorkflowNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);
  // 노드 id → 라이브 실행 상태(설계 §5 P2). 라이브 채널 이벤트 + latestRun 하이드레이트로 채움.
  const [runStates, setRunStates] = useState<Record<string, WorkflowNodeRunState>>({});
  /** 노드가 지금 무엇을 하는 중인가 — 실패가 아닌 상태 변화(C44). */
  const [nodeProgress, setNodeProgress] = useState<Record<string, string>>({});
  /* ★[로그] 탭은 실제 진행을 시간순으로 다 적는다(오너 지시 2026-08-09:
     "앞으로 로그 탭에다 실제 진행상황 다 띄워라 이런식으로 다 디테일하게").
     예전 로그 탭에는 실패 요약 몇 줄과 "실행 진행 중…" 한 줄뿐이라, 도는 동안
     화면이 아무 말도 하지 않았다. 커널이 이미 보내고 있던 이벤트를 버리지 않고 쌓는다. */
  const [activity, setActivity] = useState<
    { id: number; at: number; nodeId: string; label: string; text: string; tone: "run" | "done" | "fail" | "info" }[]
  >([]);
  const activitySeq = useRef(0);
  // 왜 멈췄고 지금 무엇을 누르면 되는지. 상태 단어만 있는 화면은 사용자에게 아무 말도 못 한다.
  const [nodeFailures, setNodeFailures] = useState<
    Record<string, { code: string; reason: string; nextAction: string }>
  >({});
  /* 승인 게이트 폐지(오너 이사회 결정 2026-08-10) — 이 화면은 더 이상 실행 중 승인을
     묻지 않는다. 스냅샷 실패는 그대로 반영한다(승인 결정으로 실패를 지우던 억제 상태도
     함께 없앴다 — 억제할 승인 카드 자체가 없다). */
  const applySnapshotFailures = useCallback(
    (next: Record<string, { code: string; reason: string; nextAction: string }> | undefined) => {
      setNodeFailures(next ?? {});
    },
    [],
  );
  // 자연어로 그래프를 고치는 제안 — 적용 전까지는 저장된 그래프를 건드리지 않는다.
  const [architectDraft, setArchitectDraft] = useState("");
  const [architectBusy, setArchitectBusy] = useState(false);
  const [architectAction, setArchitectAction] = useState<"propose" | "apply" | null>(null);
  const [architectAttachments, setArchitectAttachments] = useState<File[]>([]);
  const [architectAttachmentError, setArchitectAttachmentError] = useState("");
  const architectInputRef = useRef<HTMLTextAreaElement | null>(null);
  const architectFileInputRef = useRef<HTMLInputElement | null>(null);
  const [proposal, setProposal] = useState<{
    patch: { ops: unknown[]; rationale?: string };
    risks: string[];
    summary: { added: string[]; removed: string[]; changed: string[] };
    needsApproval: boolean;
    rationale?: string;
  } | null>(null);
  const runStatesRef = useRef<Record<string, WorkflowNodeRunState>>({});
  /**
   * 지금 실제로 도는가 — 라이브 노드 상태가 진실이다.
   * `running`(내가 방금 눌렀나)만 보면 앱을 껐다 켰거나 스케줄러가 시작한 실행에는
   * 중지 버튼이 안 나온다. 정작 멈추고 싶은 건 **내가 안 보는 사이 시작된 것**이다.
   */
  const liveRunning = Object.values(runStates).some((st) => st === "running");

  // 하단 검증 로그 패널(항목 6) — VS Code 터미널처럼 크기를 끌어서 조절한다.
  // ★기본은 접힘(카운트 줄만). 편집 중 문제가 생길 때마다 패널이 펴지며 캔버스를
  //   밀면, 드래그하던 좌표가 어긋난다(게이트 실측) — 펴는 것은 사람이 한다.
  // 하단 통합 패널은 보기 모드에서 기본으로 열려 있다 — 세션 대화·행동 카드가
  // 여기 살기 때문에, 접혀 있으면 "화면이 아무 말도 안 한다"가 된다.
  /* ★하단은 한 섹션, 세 탭 — VS Code 터미널 탭과 같은 계약(오너 지시 2026-08-09).
     예전에는 대화·로그·상세가 서로 다른 자리에 흩어져 같은 실행을 세 번
     다르게 설명했다. 한 번에 하나만 보이고, 주의가 필요한 탭은 점으로 부른다. */
  const [bottomTab, setBottomTab] = useState<"session" | "log">("session");
  const [logOpen, setLogOpen] = useState(true);
  const [logHeight, setLogHeight] = useState(260);
  useEffect(() => {
    const input = architectInputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(132, Math.max(38, input.scrollHeight))}px`;
  }, [architectDraft]);

  const addArchitectFiles = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setArchitectAttachments((current) => {
      const available = Math.max(0, 8 - current.length);
      const accepted = incoming.slice(0, available);
      setArchitectAttachmentError(incoming.length > available
        ? (locale === "en" ? "You can attach up to 8 files." : "파일은 최대 8개까지 첨부할 수 있습니다.")
        : "");
      return [...current, ...accepted];
    });
    if (architectFileInputRef.current) architectFileInputRef.current.value = "";
  }, [locale]);
  // 행동이 필요한 카드(시작 값·승인·판정 교정·의존성 수리)가 생기면 패널을 편다 —
  // 접힌 패널 뒤에서 조용히 기다리게 두지 않는다.
  /* 사람이 결정해야 끝나는 실패의 수 — 상세 탭이 이 숫자로 스스로 부른다.
     승인 대기를 사용자가 찾아 헤매지 않게 하는 유일한 신호다. */
  const decisionCount = Object.values(nodeFailures).filter((f) =>
    f.code === "EVAL_STUCK" || f.code === "CODE_DEPENDENCY_MISSING").length
    + (inputPrompt !== null ? 1 : 0);
  const hasActionCards = decisionCount > 0;
  useEffect(() => {
    // 결정이 필요해지면 패널을 열고 **그 탭으로 데려간다** — 어디를 눌러야 하는지
    // 사용자가 추측하게 두지 않는다(오너 실측: "뭘 눌러야하는지도 모르겠고").
    // 결정이 필요해지면 **오른쪽 상세를 편다** — 접힌 열 뒤에서 조용히 기다리게 두지 않는다.
    if (!hasActionCards) return;
    setRightOpen(true);
  }, [hasActionCards]);
  /* ★노드를 고르거나 팔레트를 열면 그 내용도 [상세] 탭에 산다 — 탭이 다른 데 가 있으면
     클릭해도 화면이 아무 반응이 없다. 인스펙터가 오른쪽 열이던 시절에는 항상 보였지만,
     하단 탭으로 옮긴 뒤로는 데려가 주지 않으면 사라진 기능이 된다(실렌더 2026-08-09). */
  useEffect(() => {
    // 노드·엣지를 고르거나 팔레트를 열면 그 내용이 사는 오른쪽 열을 편다.
    if (!selectedNodeId && !selectedEdgeId && !paletteOpen) return;
    setRightOpen(true);
  }, [selectedNodeId, selectedEdgeId, paletteOpen]);
  runStatesRef.current = runStates;

  const nodeStrings: NodeStrings = useMemo(
    () => ({
      connectService: t("auto.flow.connect_service"),
      trigger: t("auto.node.trigger"),
      agent: t("auto.node.agent"),
      firm: t("auto.node.firm"),
      tool: t("auto.node.tool"),
      action: t("auto.node.action"),
      output: t("auto.node.output"),
      condition: t("auto.node.condition"),
      transform: t("auto.node.transform"),
      eval: t("auto.node.eval"),
      subgraph: t("auto.node.subgraph"),
      code: t("auto.node.code"),
      subgraphUnset: t("auto.node.subgraphUnset"),
      producesLabel: t("auto.flow.produces"),
      consumesLabel: t("auto.flow.consumes"),
      failExit: locale === "en" ? "on failure" : "실패",
      failExitHint: locale === "en"
        ? "Taken only when this step fails — wire it to a step that handles the failure."
        : "이 단계가 실패했을 때만 가는 길입니다 — 실패를 처리할 단계로 이어 주세요.",
      cleanupExit: locale === "en" ? "cleanup" : "정리",
      cleanupExitHint: locale === "en"
        ? "Runs once at the end whether the step succeeded or failed — for tidying up."
        : "성공하든 실패하든 마지막에 한 번 도는 뒷정리 길입니다.",
      aiNoteHint: locale === "en"
        ? "Leave a note for the AI, or have it set this step up"
        : "AI에게 이 단계 주석·수정 맡기기",
    }),
    [t, locale],
  );

  const load = useCallback(async () => {
    const api = ipc();
    setLoading(true);
    setError("");
    if (!api || !id) {
      setError(locale === "en" ? "Automation could not be opened. Nothing changed." : "자동화를 열 수 없습니다. 바뀐 내용은 없습니다.");
      setLoading(false);
      return;
    }
    try {
      const found = await api.automations.get(id);
      if (!found) {
        router.replace("/automation");
        return;
      }
      setAutomation(found);
      // 켜기가 막혀 있으면 버튼 이름이 그렇게 말해야 한다.
      // Zapier가 발행 버튼 라벨 자체를 상태로 바꾼다(Publish / Fix to Publish /
      // Update to Publish) — 눌러 보고 나서야 아는 것보다 낫다.
      void api.automations.connectionReport(id)
        .then((report) => setBlockedByConnections(report?.activation.canActivate === false))
        .catch(() => setBlockedByConnections(false));
    } catch {
      setError(locale === "en" ? "Automation could not be loaded. Nothing changed." : "자동화를 불러오지 못했습니다. 바뀐 내용은 없습니다.");
    } finally {
      setLoading(false);
    }
  }, [id, locale, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const isSynthesized = !!automation && !automation.graph;

  // 저장 그래프 or 합성 그래프 → 필요 시 결정적 재배치. 편집 상태는 rfNodes/rfEdges가 소유하므로
  // 이 그래프는 "초기 시드"로만 쓴다(automation이 새로 로드될 때만 하이드레이트).
  const seedGraph: WorkflowGraph | null = useMemo(() => {
    if (!automation) return null;
    const g = automation.graph ?? synthesizeLegacyGraph(automation);
    if (needsLayout(g)) return { ...g, nodes: layoutGraph(g) };
    return g;
  }, [automation]);

  // automation 로드/변경 시 캔버스 시드.
  useEffect(() => {
    if (!seedGraph) return;
    // 저장 직후 1회는 건너뛴다 — 캔버스가 이미 방금 저장한 그 상태다(save() 주석 참고).
    if (skipNextHydrationRef.current) {
      skipNextHydrationRef.current = false;
      return;
    }
    seq.current = seedGraph.nodes.length;
    setRfNodes(
      seedGraph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: 0, y: 0 },
        data: {
          label: n.label,
          config: n.config,
          strings: nodeStrings,
          connectable: editing,
          runState: runStatesRef.current[n.id],
        },
        draggable: editing,
        selectable: true,
      })),
    );
    /*
     * ★분기 노드(eval·condition)는 핸들이 **`true`/`false` 둘뿐**이고 `out-b` 가 없다.
     *   그래서 핸들을 안 적은 엣지를 `out-b` 로 붙이면 **없는 자리를 가리켜 선이
     *   통째로 사라진다.** 실측 2026-08-20 (캠페인 E3): 8노드 7엣지로 사슬이 완전한
     *   그래프가 화면에서는 두 덩어리로 끊어져 보였고, 오너가 "연결이 다 안 되어
     *   있는데"라고 지적했다. 데이터는 멀쩡한데 화면이 거짓말한 것이다.
     *
     *   커널은 검증을 통과하면 참 쪽으로 간다 — 그러니 핸들이 없으면 `true` 다.
     */
    const branchy = new Set(
      seedGraph.nodes.filter((n) => n.type === "eval" || n.type === "condition").map((n) => n.id),
    );
    setRfEdges(
      seedGraph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // ★핸들을 안 적은 옛 엣지는 기본 자리(아래→위)로 붙인다. 노드에 핸들이 여러 개가
        //   된 뒤로는 붙일 자리를 안 정해 주면 **선이 통째로 안 그려진다** — 잘 돌던
        //   그래프가 화면에서만 사라지는 최악의 모양이다. 저장 시에는 원래 값을 다시 쓴다.
        sourceHandle: e.sourceHandle ?? (branchy.has(e.source) ? "true" : "out-b"),
        targetHandle: "in-t",
        // ★되돌아가는 반복의 상한은 **엣지에** 붙어 있다. 여기서 안 들고 오면 저장할 때
        //   같이 사라지고, 잘 돌던 그래프가 그때부터 LOOP_BOUND_UNDECLARED로 거절된다
        //   (실측: 자연어로 만든 반복 그래프를 캔버스에서 열었다 저장하기만 해도 죽었다).
        data: typeof e.maxIterations === "number" ? { maxIterations: e.maxIterations } : undefined,
        label: e.sourceHandle && !/^out-[tblr]$/.test(e.sourceHandle) ? e.sourceHandle : undefined,
        // ★선은 직각으로 꺾인다(오너 실판정 2026-08-06) — 대각선 베지어는 노드 사이를
        //   가로질러 스파게티가 된다. 꺾인 선은 위→아래 배치와 함께 회로도처럼 읽힌다.
        type: "smoothstep",
        pathOptions: { borderRadius: 8 },
        animated: false,
        style: { stroke: "var(--muted-deep)", strokeWidth: 1.4 },
        labelStyle: { fontFamily: "var(--font-mono)", fontSize: 10, fill: "var(--muted-deep)" },
        labelBgStyle: { fill: "var(--paper)" },
      })),
    );
    setDirty(false);
    // seedGraph만 의존(nodeStrings/editing 변화는 아래 별도 effect로 반영).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedGraph]);

  // editing/locale 토글 시 노드 data.connectable + draggable 갱신(그래프 구조는 유지).
  useEffect(() => {
    setRfNodes((nodes) =>
      nodes.map((n) => ({
        ...n,
        draggable: editing,
        data: {
          ...n.data,
          strings: nodeStrings,
          connectable: editing,
          // 노드 좌상단 AI 주석 CTA(항목 5) — 편집 모드에서만 살아 있다.
          onAiNote: editing
            ? () => setAiNote({
              nodeId: n.id,
              label: String((n.data as WorkflowNodeData).label ?? n.id),
              text: String(((n.data as WorkflowNodeData).config as { note?: unknown })?.note ?? ""),
            })
            : undefined,
        },
      })),
    );
  }, [editing, nodeStrings, setRfNodes]);

  // 라이브 실행 오버레이(설계 §5 P2) — 자동화별 라이브 채널을 구독해 per-node 상태를 받고,
  // 초기엔 latestRun 스냅샷으로 하이드레이트(새로고침 후에도 마지막 실행 상태 복원).
  useEffect(() => {
    if (!automation) return;
    const api = ipc();
    const events = ipcEvents();
    let cancelled = false;
    // 초기 하이드레이트.
    void api?.automations.latestRun(automation.id).then((snap) => {
      if (!cancelled && snap && snap.nodeStates) setRunStates(snap.nodeStates);
      if (!cancelled) applySnapshotFailures(snap?.nodeFailures);
      if (!cancelled) setRunStartedAt(snap?.startedAt ?? null);
    });
    if (!events) return;
    const channel = api?.automations.liveRunChannel(automation.id);
    if (!channel) return;
    const off = events.on(channel, (ev) => {
      // ★들어온 사실을 그대로 한 줄씩 남긴다 — 요약하지 않는다. 요약은 상태줄이 한다.
      const pushActivity = (text: string, tone: "run" | "done" | "fail" | "info") => {
        const nodeId = String(ev.nodeId ?? "");
        // The last fallback is rendered in the activity feed, so it followed the
        // node label into English sessions as Korean.
        const label = automation.graph?.nodes.find((n) => n.id === nodeId)?.label
          || nodeId
          || (locale === "en" ? "graph" : "그래프");
        activitySeq.current += 1;
        const id = activitySeq.current;
        // 뒤에서부터 400줄만 — 긴 실행에서 메모리와 렌더를 지킨다.
        setActivity((prev) => [...prev, { id, at: Date.now(), nodeId, label, text, tone }].slice(-400));
      };
      if (ev.nodeId && ev.nodeState) {
        setRunStates((prev) => ({ ...prev, [ev.nodeId as string]: ev.nodeState as WorkflowNodeRunState }));
        const stateText: Record<string, string> = {
          running: locale === "en" ? "started" : "시작",
          done: locale === "en" ? "finished" : "완료",
          failed: locale === "en" ? "stopped" : "멈춤",
          skipped: locale === "en" ? "skipped" : "건너뜀",
          pending: locale === "en" ? "queued" : "대기",
        };
        const text = stateText[ev.nodeState as string] ?? String(ev.nodeState);
        pushActivity(
          ev.model ? `${text} · ${ev.model}` : text,
          ev.nodeState === "running" ? "run" : ev.nodeState === "failed" ? "fail" : ev.nodeState === "done" ? "done" : "info",
        );
      }
      // 도구 호출·생각·위임은 "지금 실제로 무엇을 하는 중인가"의 전부다.
      if (ev.kind === "tool-use" && ev.tool?.name) {
        pushActivity((locale === "en" ? "tool " : "도구 ") + ev.tool.name, "info");
      } else if (ev.kind === "reasoning" && ev.reasoning?.phase === "start") {
        pushActivity(locale === "en" ? "thinking" : "생각하는 중", "info");
      } else if (ev.kind === "thinking" && ev.status) {
        pushActivity(String(ev.status).slice(0, 120), "info");
      } else if (ev.delegateTo?.length) {
        pushActivity((locale === "en" ? "delegating to " : "위임 → ") + ev.delegateTo.join(", "), "info");
      }
      // ★실패가 아닌 **상태 변화**를 받는다(커넥터 C44). 예전에는 nodeState만 건너와서,
      //   긴 노드가 도는 동안 화면이 "실행 중"에 멈춰 있었다 — 사람은 그걸 "멈췄다"로 읽는다.
      if (!ev.nodeId) return;
      const progress = ev.kind === "tool-use"
        ? (ev.tool?.name ?? ev.status ?? "")
        : ev.kind === "thinking"
          ? (ev.status ?? "")
          : ev.kind === "reasoning" && ev.reasoning?.phase === "start"
            ? "생각하는 중"
            : "";
      if (progress) {
        setNodeProgress((prev) => ({ ...prev, [ev.nodeId as string]: progress.slice(0, 60) }));
      }
      // 노드가 끝나면 그 노드의 진행 문구는 지운다 — 끝난 단계에 옛 문구가 남으면
      // 아직 그걸 하고 있는 것처럼 보인다.
      if (ev.nodeState && ev.nodeState !== "running") {
        setNodeProgress((prev) => {
          const next = { ...prev };
          delete next[ev.nodeId as string];
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [automation]);

  /* ★실행이 끝났는데 화면이 왜 멈췄는지 말을 못 하던 자리.
     라이브 이벤트는 `nodeState: "failed"` 만 실어 오고, **사유는 실려 오지 않는다** —
     커널이 사유를 DB에 쓰는 것은 실행이 끝날 때(`saveGraphRunFailures`)다. 그래서
     라이브로 지켜보던 사람에게는 빨간 노드 하나만 남고, 카드도 로그 줄도 상태줄도
     아무 말을 안 했다. 새로고침해야 비로소 이유가 나왔다(실렌더 2026-08-09).
     도는 동안, 그리고 끝난 직후 한 번 더 스냅샷을 당겨온다. */
  useEffect(() => {
    if (!automation) return;
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    const pull = () => {
      void api.automations.latestRun(automation.id).then((snap) => {
        if (cancelled || !snap) return;
        if (snap.nodeStates) {
          const next = snap.nodeStates;
          // 무변경 틱마다 새 객체를 넣으면 노드/엣지 재구성 이펙트가 3초마다
          // 캔버스 전체를 다시 그린다 — 값이 같으면 이전 참조를 유지한다.
          setRunStates((prev) => {
            const prevKeys = Object.keys(prev);
            const nextKeys = Object.keys(next);
            if (prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k])) {
              return prev;
            }
            return next;
          });
        }
        applySnapshotFailures(snap.nodeFailures);
        setRunStartedAt(snap.startedAt ?? null);
      }).catch(() => undefined);
    };
    if (liveRunning) {
      // 숨은 창에서는 스냅샷 폴을 멈추고, 다시 보이면 즉시 한 번 당긴다.
      const tick = () => { if (document.visibilityState !== "hidden") pull(); };
      const onVisible = () => { if (document.visibilityState !== "hidden") pull(); };
      const id = window.setInterval(tick, 3_000);
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        cancelled = true;
        window.clearInterval(id);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
    // 마지막 노드 이벤트와 커널의 마무리 쓰기 사이에 틈이 있다 — 끝난 뒤 한 번 더.
    const id = window.setTimeout(pull, 1_200);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [automation, liveRunning]);

  // runStates가 바뀔 때마다 노드 data.runState 주입(캔버스가 테두리/펄스로 애니메이션).
  useEffect(() => {
    setRfNodes((nodes) => nodes.map((n) => ({
      ...n,
      data: { ...n.data, runState: runStates[n.id], progress: nodeProgress[n.id] },
    })));
  }, [runStates, nodeProgress, setRfNodes]);

  // 실행 중 노드로 향하는 엣지를 애니메이션(러너가 흐르는 wire를 시각화).
  useEffect(() => {
    setRfEdges((edges) =>
      edges.map((e) => {
        const targetRunning = runStates[e.target] === "running";
        const sourceDone = runStates[e.source] === "done";
        const active = targetRunning || (sourceDone && runStates[e.target] === "running");
        return {
          ...e,
          animated: targetRunning,
          style: {
            ...e.style,
            stroke: active ? "var(--accent)" : "var(--muted-deep)",
            strokeWidth: active ? 2 : 1.4,
          },
        };
      }),
    );
  }, [runStates, setRfEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<WorkflowNodeData>>[]) => {
      onNodesChangeBase(changes);
      if (editing && changes.some((c) => c.type === "position" || c.type === "remove")) setDirty(true);
    },
    [onNodesChangeBase, editing],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChangeBase(changes);
      if (editing && changes.some((c) => c.type === "remove")) setDirty(true);
    },
    [onEdgesChangeBase, editing],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!editing) return;
      setRfEdges((eds) =>
        addEdge(
          {
            ...conn,
            id: `e-${conn.source}-${conn.target}-${Date.now()}`,
            // condition 노드의 true/false 핸들에서 그으면 라벨도 동기화(표시용). 진실원본은
            // 네이티브 sourceHandle 필드(...conn에 포함)이며 저장 시 그걸 우선 읽는다.
            ...(conn.sourceHandle ? { label: conn.sourceHandle } : {}),
            type: "smoothstep",
            style: { stroke: "var(--muted-deep)", strokeWidth: 1.4 },
          },
          eds,
        ),
      );
      setDirty(true);
    },
    [editing, setRfEdges],
  );

  // 편집 중 라이브 검증(설계 §5 P2 workflow-validate) — dangling/변수-매치 이슈를 표면화.
  const issues: WorkflowIssue[] = useMemo(() => {
    if (!editing) return [];
    const graph: WorkflowGraph = {
      version: 1,
      // ★실행 총계 상한(budget)은 캔버스가 만들지도 지우지도 않는다 — 그대로 들고 간다.
      //   엣지의 반복 상한과 같은 병인데 이쪽이 더 조용하다: 상한이 사라지면 실행이 거절되는
      //   게 아니라 **그냥 상한 없이 잘 돈다.** 아무도 알아채지 못한다.
      ...(seedGraph?.budget ? { budget: seedGraph.budget } : {}),
      nodes: rfNodes.map((n) => ({
        id: n.id,
        type: (n.type as WorkflowNode["type"]) ?? "agent",
        position: n.position,
        config: n.data.config ?? {},
        label: n.data.label,
      })),
      edges: rfEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // 조건 분기는 React Flow 네이티브 sourceHandle 필드가 진실원본(새로 그린 엣지). 없으면
        // 라벨로 폴백(과거에 로드된 엣지). 둘 다 없으면 무조건 엣지.
        //
        // ★`out-t|b|l|r`는 **화면이 어느 면에 붙였나**일 뿐이라 그래프에 저장하지 않는다.
        //   커널이 아는 sourceHandle은 true/false/error/always뿐이고, 화면 좌표가 그 자리에
        //   섞여 들어가면 조건 분기가 어느 쪽도 아닌 값이 되어 실행이 거절된다
        //   (EDGE_CONDITION_UNRESOLVED). 배치는 화면 것, 배선 의미는 그래프 것이다.
        ...(e.sourceHandle && !/^out-[tblr]$/.test(e.sourceHandle)
          ? { sourceHandle: e.sourceHandle }
          : typeof e.label === "string" && e.label && !/^out-[tblr]$/.test(e.label)
            ? { sourceHandle: e.label }
            : {}),
        // ★상한은 캔버스가 만들지도 지우지도 않는다 — 있으면 그대로 되돌려 놓는다.
        ...(typeof (e.data as { maxIterations?: unknown } | undefined)?.maxIterations === "number"
          ? { maxIterations: (e.data as { maxIterations: number }).maxIterations }
          : {}),
      })),
    };
    return validateWorkflow(graph, locale);
  }, [editing, rfNodes, rfEdges, locale]);
  useEffect(() => {
    if (!pendingFitRef.current) return;
    pendingFitRef.current = false;
    // 측정이 끝난 다음 프레임에 — 안 그러면 새 노드 크기를 모른 채 계산한다.
    const id = window.setTimeout(() => fitView({ ...FIT_VIEW, duration: 150 }), 30);
    return () => window.clearTimeout(id);
  }, [rfNodes.length, fitView]);

  /*
   * ★실행 에러·워닝도 이 로그로 온다(오너 지시 — 169 항목 6번). 처음엔 편집 검증만
   * 옮기고 실행 실패는 상단 팝업에 남겨 뒀는데, 그 팝업이 정확히 "캔버스를 밀어내고
   * 읽기 전에 사라지는" 원래 문제였다. 편집 중엔 검증 이슈, 평시엔 최근 실행의
   * 실패·상태가 같은 패널에 줄로 쌓인다 — VS Code 하단 패널과 같은 계약.
   */
  const runLogEntries: WorkflowIssue[] = useMemo(() => {
    if (editing) return [];
    const rows: WorkflowIssue[] = [];
    for (const [nodeId, failure] of Object.entries(nodeFailures)) {
      const node = automation?.graph?.nodes.find((n) => n.id === nodeId);
      const when = runStartedAt
        ? new Date(runStartedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "";
      rows.push({
        severity: "error",
        nodeId,
        code: "dangling-node", // 로그 표시용 자리 — 문구는 message가 전부 말한다.
        // ★시각을 앞세운다 — 어제의 실패(옛 claude 핀 시절 기록)가 "지금 클로드를 쓰고
        //   있다"는 오해를 낳았다(실측). 기록은 기록으로 읽히게 한다.
        message: `${when ? `[${when}] ` : ""}${node?.label || nodeId} — ${failure.reason || failure.code}`,
      } as unknown as WorkflowIssue);
    }
    if (liveRunning) {
      rows.push({ severity: "warning", code: "dangling-node",
        message: locale === "en" ? "Run in progress…" : "실행 진행 중…" } as unknown as WorkflowIssue);
    }
    return rows;
  }, [editing, nodeFailures, liveRunning, automation?.graph, locale, runStartedAt]);
  const logRows = editing ? issues : runLogEntries;
  const errorCount = logRows.filter((i) => i.severity === "error").length;
  const warnCount = logRows.filter((i) => i.severity === "warning").length;

  /* ★"지금 무슨 상태이고, 무엇을 누르면 되는가" — 화면에 이 답이 정확히 한 군데 있어야 한다.
     오너 실측(2026-08-09 녹화): 툴바에 버튼 8개, 하단에 카드 여러 장, 어느 것도
     "지금 이걸 누르세요"라고 말하지 않아 [지금 다시 실행]만 반복해서 눌렸다.
     Norman의 평가의 간극(무슨 일이 일어났는가) + 실행의 간극(무엇을 하면 되는가)을
     한 줄로 닫는다. 주 행동은 **언제나 하나**다(Hick-Hyman: 선택지가 늘수록 결정이 늦다). */
  // 멈춘 실행이 있으면 "지금 실행"은 실제로 **이어서 실행**이다(run-graph 가 같은
  // occurrence 체크포인트에서 재개한다). 버튼이 하는 일과 이름이 달라 사용자는
  // 매번 "처음부터 도는 건가?"를 물어야 했다 — 이름을 하는 일에 맞춘다.
  const resumable = !editing && !liveRunning
    && Object.values(runStates).some((st) => st === "done")
    && (Object.keys(nodeFailures).length > 0 || Object.values(runStates).some((st) => st === "failed"));
  const runningNodeLabel = useMemo(() => {
    const id = Object.entries(runStates).find(([, st]) => st === "running")?.[0];
    if (!id) return "";
    return automation?.graph?.nodes.find((n) => n.id === id)?.label || id;
  }, [runStates, automation?.graph]);
  const totalNodes = automation?.graph?.nodes.length ?? 0;
  const doneNodes = Object.values(runStates).filter((st) => st === "done").length;
  // 상세 탭이 지금 펼쳐져 보이는가 — 상태줄이 같은 행동을 두 번 내놓지 않기 위한 조건.
  const detailsShown = rightOpen;
  // 멈췄는가 — 사유가 아직 안 실렸어도 노드가 failed 면 멈춘 것이다. 사유가 없다고
  // "정상 종료"처럼 말하면, 빨간 노드를 보고 있는 사람에게 화면이 거짓말을 한다.
  const stopped = errorCount > 0 || Object.values(runStates).some((st) => st === "failed");
  const freshStartable = !editing && !liveRunning && stopped;

  const selectedNode: WorkflowNode | null = useMemo(() => {
    if (!selectedNodeId) return null;
    const rf = rfNodes.find((n) => n.id === selectedNodeId);
    if (!rf) return null;
    return {
      id: rf.id,
      type: (rf.type as WorkflowNode["type"]) ?? "agent",
      position: rf.position,
      config: rf.data.config,
      label: rf.data.label,
    };
  }, [selectedNodeId, rfNodes]);

  /**
   * 되돌아가는 연결인가 — 트리거에서 오는 순서상 **뒤에서 앞으로** 가는 연결이다.
   * 커널이 반복으로 읽는 것과 같은 모양이고, 이것만 상한을 요구한다.
   */
  const backEdgeIds = useMemo(() => {
    // ★DFS 색칠 — 커널 findBackEdges·검증기와 같은 방식. 전위 번호 비교 휴리스틱은
    //   사이클 없는 다이아몬드를 반복으로 오인해, 반복도 아닌 연결에 상한을 물어본다.
    const adjacency = new Map<string, { to: string; edgeId: string }[]>();
    for (const e of rfEdges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      adjacency.get(e.source)!.push({ to: e.target, edgeId: e.id });
    }
    const color = new Map<string, "gray" | "black">();
    const back = new Set<string>();
    const visit = (id: string): void => {
      color.set(id, "gray");
      for (const out of adjacency.get(id) ?? []) {
        const c = color.get(out.to);
        if (c === "gray") back.add(out.edgeId);
        else if (c === undefined) visit(out.to);
      }
      color.set(id, "black");
    };
    // ★커널 findBackEdges와 **같은 시작점 규칙**: 들어오는 연결이 없는 노드부터 돈다.
    //   DFS 색칠에서 어느 엣지가 되돌아가는 연결이 되는지는 시작점에 달려 있다.
    //   순서가 다르면 화면은 A→B에 상한을 물어보고 커널은 B→A를 요구해, 저장은 통과하는데
    //   실행만 거절되고 상한을 넣을 자리는 없는 상태로 되돌아간다.
    const hasIncoming = new Set(rfEdges.map((e) => e.target));
    for (const n of rfNodes) if (!hasIncoming.has(n.id) && !color.has(n.id)) visit(n.id);
    for (const n of rfNodes) if (!color.has(n.id)) visit(n.id);
    return back;
  }, [rfEdges, rfNodes]);

  const selectedEdge = useMemo(
    () => (selectedEdgeId ? rfEdges.find((e) => e.id === selectedEdgeId) ?? null : null),
    [selectedEdgeId, rfEdges],
  );

  const setLoopBound = useCallback((value: number | null) => {
    if (!selectedEdgeId) return;
    setRfEdges((eds) => eds.map((e) => (e.id === selectedEdgeId
      ? { ...e, data: value == null ? undefined : { ...(e.data ?? {}), maxIterations: value } }
      : e)));
    setDirty(true);
  }, [selectedEdgeId]);

  function addPaletteNode(seed: PaletteNodeSeed) {
    const nid = `n${seq.current++}-${Date.now()}`;
    // 결정적 배치: 기존 노드 오른쪽 끝 + 한 칸, y는 계단형으로 흩뿌려 겹침 방지.
    const maxX = rfNodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    const y = 120 + (rfNodes.length % 3) * 90;
    setRfNodes((nodes) => [
      ...nodes,
      {
        id: nid,
        type: seed.type,
        position: { x: maxX + 280, y },
        data: { label: seed.label, config: seed.config, strings: nodeStrings, connectable: true },
        draggable: true,
        selectable: true,
      },
    ]);
    // ★새 노드가 화면 밖(오른쪽 패널 아래)에 떨어지면 사람은 "안 생겼다"로 읽고,
    //   이어 그리려던 선은 패널에 먹힌다(게이트 실측). 놓자마자 보이게 당겨 온다.
    //   rAF는 React 커밋보다 먼저 돌 수 있어 — 노드 수 변화를 보는 효과가 맞춘다.
    pendingFitRef.current = true;
    setSelectedNodeId(nid);
    // ★놓았으면 팔레트를 닫는다. 팔레트와 설정 패널이 **같은 자리**를 쓰기 때문에,
    //   열어둔 채로 두면 방금 놓은 노드는 물론 다른 어느 노드를 눌러도 설정이 안 열린다
    //   — 사람은 "추가 → 방금 것 설정" 순서로 일하므로 편집이 그 자리에서 막힌다(실측).
    setPaletteOpen(false);
    setDirty(true);
  }

  function patchSelected(patch: Record<string, unknown>) {
    if (!selectedNodeId) return;
    setRfNodes((nodes) =>
      nodes.map((n) =>
        n.id === selectedNodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n,
      ),
    );
    setDirty(true);
  }

  function labelSelected(label: string) {
    if (!selectedNodeId) return;
    setRfNodes((nodes) => nodes.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, label } } : n)));
    setDirty(true);
  }

  function deleteSelected() {
    if (!selectedNodeId) return;
    setRfNodes((nodes) => nodes.filter((n) => n.id !== selectedNodeId));
    setRfEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    setDirty(true);
  }

  /** 현재 캔버스(rfNodes/rfEdges) → WorkflowGraph 직렬화. */
  function toGraph(): WorkflowGraph {
    return {
      version: 1,
      // ★실행 총계 상한(budget)은 캔버스가 만들지도 지우지도 않는다 — 그대로 들고 간다.
      //   엣지의 반복 상한과 같은 병인데 이쪽이 더 조용하다: 상한이 사라지면 실행이 거절되는
      //   게 아니라 **그냥 상한 없이 잘 돈다.** 아무도 알아채지 못한다.
      ...(seedGraph?.budget ? { budget: seedGraph.budget } : {}),
      nodes: rfNodes.map((n) => ({
        id: n.id,
        type: (n.type as WorkflowNode["type"]) ?? "agent",
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        config: n.data.config ?? {},
        label: n.data.label,
      })),
      edges: rfEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // 조건 분기는 React Flow 네이티브 sourceHandle 필드가 진실원본(새로 그린 엣지). 없으면
        // 라벨로 폴백(과거에 로드된 엣지). 둘 다 없으면 무조건 엣지.
        ...(e.sourceHandle
          ? { sourceHandle: e.sourceHandle }
          : typeof e.label === "string" && e.label
            ? { sourceHandle: e.label }
            : {}),
        // ★상한은 캔버스가 만들지도 지우지도 않는다 — 있으면 그대로 되돌려 놓는다.
        ...(typeof (e.data as { maxIterations?: unknown } | undefined)?.maxIterations === "number"
          ? { maxIterations: (e.data as { maxIterations: number }).maxIterations }
          : {}),
      })),
    };
  }

  function autoLayoutCanvas() {
    const graph = toGraph();
    const laidOut = layoutGraph(graph);
    const positions = new Map(laidOut.map((n) => [n.id, n.position] as const));
    setRfNodes((nodes) =>
      nodes.map((n) => ({
        ...n,
        position: positions.get(n.id) ?? n.position,
      })),
    );
    setDirty(true);
  }

  async function publishToHub() {
    const api = ipc();
    if (!api || !automation || publishing) return;
    setPublishing(true);
    setMessage(locale === "en" ? "Publishing to the Hub…" : "Hub에 올리는 중입니다…");
    try {
      const res = await api.automations.publishGraph(automation.id);
      // 거절이든 성공이든 **무엇이 일어났는지 그대로** 말한다.
      setMessage(res.ok
        ? (locale === "en" ? `Published as ${res.slug} (${res.version}).` : `Hub에 올렸습니다 — ${res.slug} (${res.version}).`)
        : res.reason);
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : (locale === "en" ? "Publishing failed." : "올리지 못했습니다."));
    } finally {
      setPublishing(false);
    }
  }

  useEffect(() => {
    if (automation?.toolMode !== "computer-use") { setCuaPerm(null); return; }
    void ipc()?.automations.computerUsePermissions().then(setCuaPerm).catch(() => setCuaPerm(null));
  }, [automation?.toolMode]);

  async function openVersions() {
    const api = ipc();
    if (!api || !automation) return;
    setVersionsOpen(true);
    try {
      setVersions(await api.automations.listGraphVersions(automation.id));
    } catch {
      setVersions([]);
    }
  }

  async function restoreVersion(versionId: string) {
    const api = ipc();
    if (!api || !automation || restoring) return;
    const previous = automation;
    setRestoring(versionId);
    try {
      const result = await api.automations.restoreGraphVersion(automation.id, versionId);
      if (!result.ok) {
        setMessage(locale === "en" ? "Could not restore that version." : "그 판으로 되돌리지 못했습니다.");
        return;
      }
      const restored = exactAutomationProjection(result.automation, previous.id);
      if (result.automationId !== previous.id || result.versionId !== versionId || !restored) {
        throw new Error("automation_restore_receipt_mismatch");
      }
      setVersionsOpen(false);
      setAutomation(restored);
      setMessage(locale === "en" ? "Restored. The version you were on is still in the list." : "되돌렸습니다. 방금까지의 판도 목록에 남아 있습니다.");
    } catch {
      try {
        const current = exactAutomationProjection(await api.automations.get(previous.id), previous.id);
        if (!current) throw new Error("automation_restore_readback_missing");
        if (sameWorkflowGraph(current.graph, previous.graph)) {
          setMessage(locale === "en"
            ? "The current graph still matches the graph from before this request. The requested version was not confirmed; reopen version history before trying again."
            : "현재 그래프는 요청 전과 같습니다. 요청한 판으로의 복구는 확인되지 않았습니다. 다시 누르기 전에 버전 기록을 새로 여세요.");
        } else {
          setVersionsOpen(false);
          setAutomation(current);
          setMessage(locale === "en"
            ? "The saved graph changed, but the requested version could not be verified because its response was lost. Review this graph and do not restore again just to check."
            : "저장된 그래프는 바뀌었지만 응답이 유실되어 요청한 판인지 확인하지 못했습니다. 현재 그래프를 검토하고 확인 목적으로 복구를 반복하지 마세요.");
        }
      } catch {
        setMessage(locale === "en"
          ? "The restore request may already have changed the saved graph, but its final state could not be read. Do not repeat it; reopen this automation and inspect version history first."
          : "복구 요청이 저장된 그래프를 이미 바꿨을 수 있으나 최종 상태를 읽지 못했습니다. 반복하지 말고 자동화를 다시 연 뒤 버전 기록부터 확인하세요.");
      }
    } finally {
      setRestoring("");
    }
  }

  async function save() {
    const api = ipc();
    if (!api || !automation) return;
    const previous = automation;
    const requestedGraph = toGraph();
    setSaving(true);
    setMessage("");
    try {
      const receipt = await api.automations.updateGraph(previous.id, requestedGraph);
      const next = exactAutomationProjection(receipt, previous.id);
      if (!next || !sameWorkflowGraph(next.graph, requestedGraph)) {
        throw new Error("automation_save_receipt_mismatch");
      }
      // ★저장 직후에는 캔버스가 진실이다. setAutomation이 하이드레이션을 다시 돌리면
      //   needsLayout(겹침 휴리스틱)이 사용자가 손으로 잡은 배치를 결정적 재배치로
      //   덮어썼다 — "저장을 눌렀더니 그래프 생김새가 바뀐다"(오너 실측 2026-08-08).
      //   방금 저장한 그래프로는 캔버스를 재시드하지 않는다.
      skipNextHydrationRef.current = true;
      setAutomation(next);
      setDirty(false);
      setMessage(t("auto.flow.saved"));
    } catch {
      try {
        const current = exactAutomationProjection(await api.automations.get(previous.id), previous.id);
        if (!current) throw new Error("automation_save_readback_missing");
        if (sameWorkflowGraph(current.graph, requestedGraph)) {
          skipNextHydrationRef.current = true;
          setAutomation(current);
          setDirty(false);
          setMessage(locale === "en"
            ? "Saved. The reply was incomplete, so the saved graph was read back and confirmed."
            : "저장했습니다. 응답이 불완전해 저장된 그래프를 다시 읽어 확인했습니다.");
        } else if (sameWorkflowGraph(current.graph, previous.graph)) {
          setMessage(locale === "en"
            ? "The saved graph is still the previous version. Your edit remains here and can be saved again."
            : "저장된 그래프는 이전 판 그대로입니다. 편집 내용은 이 화면에 남아 있어 다시 저장할 수 있습니다.");
        } else {
          setMessage(locale === "en"
            ? "The saved graph is neither the previous version nor this edit. Your edit remains on screen; reopen the automation to inspect the saved version before saving again."
            : "저장된 그래프가 이전 판도, 지금 편집한 판도 아닙니다. 편집 내용은 화면에 남아 있으니 다시 저장하기 전에 자동화를 다시 열어 저장본을 확인하세요.");
        }
      } catch {
        setMessage(locale === "en"
          ? "The save request may have been applied, but the saved graph could not be verified. Your edit remains here; do not save again until you reopen and inspect it."
          : "저장 요청이 반영됐을 수 있으나 저장된 그래프를 확인하지 못했습니다. 편집 내용은 남아 있으니 다시 열어 확인하기 전에는 저장을 반복하지 마세요.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    const api = ipc();
    if (!api || !automation || togglingRef.current) return;
    const previous = automation;
    const requestedEnabled = !previous.enabled;
    // ★누르면 **먼저** 반응한다. 예전에는 켜기 게이트(연결 검사)가 도는 몇 초 동안
    //   버튼이 그대로여서, 사람은 "안 눌렸나?" 하고 다시 눌렀다.
    togglingRef.current = true;
    setToggling(true);
    setMessage(automation.enabled
      ? (locale === "en" ? "Turning it off…" : "끄는 중입니다…")
      : (locale === "en" ? "Turning it on — checking what it needs…" : "켜는 중입니다 — 필요한 연결을 확인합니다…"));
    try {
      const receipt = await api.automations.toggle(previous.id, requestedEnabled);
      const next = exactAutomationProjection(receipt, previous.id);
      if (!next || next.enabled !== requestedEnabled) throw new Error("automation_toggle_receipt_mismatch");
      setAutomation(next);
      setMessage(requestedEnabled
        ? (locale === "en" ? "Automation is on." : "자동화를 켰습니다.")
        : (locale === "en" ? "Automation is off." : "자동화를 껐습니다."));
    } catch (error) {
      // 켜기 게이트가 막았으면 **그 사유를 그대로** 보여주고 연결 창을 연다.
      // "상태를 바꾸지 못했습니다"만 남기면 사용자는 왜인지 영영 모른다(실사용 실측의 반복).
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const notConnected = raw.includes("AUTOMATION_NOT_CONNECTED") || raw.includes("연결되지 않은");
      try {
        const current = exactAutomationProjection(await api.automations.get(previous.id), previous.id);
        if (!current) throw new Error("automation_toggle_readback_missing");
        if (current.enabled === requestedEnabled) {
          setAutomation(current);
          setMessage(requestedEnabled
            ? (locale === "en" ? "Automation is on. The reply was incomplete, so the saved status was read back and confirmed." : "자동화를 켰습니다. 응답이 불완전해 저장 상태를 다시 읽어 확인했습니다.")
            : (locale === "en" ? "Automation is off. The reply was incomplete, so the saved status was read back and confirmed." : "자동화를 껐습니다. 응답이 불완전해 저장 상태를 다시 읽어 확인했습니다."));
        } else if (current.enabled === previous.enabled) {
          setAutomation(current);
          if (notConnected) {
            setMessage(raw.replace(/^Error:\s*/, "").replace(/^.*AUTOMATION_NOT_CONNECTED[^:]*:\s*/, ""));
            setConnectionsOpen(true);
          } else {
            setMessage(locale === "en"
              ? "The saved status did not change. You can try this action again."
              : "저장된 상태는 바뀌지 않았습니다. 이 작업은 다시 시도할 수 있습니다.");
          }
        } else {
          setAutomation(current);
          setMessage(locale === "en"
            ? "The saved status changed to a different value. Review it before trying another status change."
            : "저장 상태가 요청과 다른 값으로 바뀌었습니다. 다른 상태 변경을 시도하기 전에 확인하세요.");
        }
      } catch {
        setMessage(locale === "en"
          ? "The status request may have been applied, but the saved status could not be verified. Do not repeat it; reopen this automation first."
          : "상태 요청이 반영됐을 수 있으나 저장 상태를 확인하지 못했습니다. 반복하지 말고 자동화를 먼저 다시 여세요.");
      }
    } finally {
      togglingRef.current = false;
      setToggling(false);
    }
  }

  // ── 노드 AI 주석(항목 5) — 노드에서 바로 "이 단계만" 고쳐 달라고 말한다 ────
  const [aiNote, setAiNote] = useState<{ nodeId: string; label: string; text: string } | null>(null);

  /** 주석만 저장 — 노드 config.note에 남는다(AI가 다음에 이 단계를 지을 때 읽는 메모). */
  function saveAiNote() {
    if (!aiNote) return;
    setRfNodes((nodes) => nodes.map((n) => n.id === aiNote.nodeId
      ? { ...n, data: { ...n.data, config: { ...(n.data as WorkflowNodeData).config, note: aiNote.text } } }
      : n));
    setDirty(true);
    setAiNote(null);
  }

  /** 주석을 그 노드 한정 지시로 만들어 architect에 바로 보낸다 — 제안·승인 흐름은 기존과 동일. */
  async function aiSetNode() {
    if (!aiNote?.text.trim()) return;
    const scoped = locale === "en"
      ? `Change ONLY the step "${aiNote.label}" (node id ${aiNote.nodeId}). Do not touch other steps. Instruction: ${aiNote.text.trim()}`
      : `"${aiNote.label}" 단계(노드 id ${aiNote.nodeId})만 바꿔 주세요. 다른 단계는 건드리지 마세요. 지시: ${aiNote.text.trim()}`;
    setAiNote(null);
    setArchitectDraft(scoped);
    const api = ipc();
    if (!api || !automation) return;
    setArchitectBusy(true);
    setArchitectAction("propose");
    setProposal(null);
    setMessage(locale === "en" ? "Working out what would change..." : "무엇이 바뀔지 알아보는 중입니다...");
    try {
      const result = await api.automations.requestGraphPatch(automation.id, scoped);
      if (!result.ok) { setMessage(`${result.reason} ${result.nextAction}`); return; }
      setProposal(result);
      setMessage(locale === "en"
        ? "Nothing has changed yet. Review it and apply."
        : "아직 아무것도 바뀌지 않았습니다. 내용을 확인하고 적용하세요.");
    } catch {
      setMessage(locale === "en" ? "The change could not be worked out." : "변경 내용을 만들지 못했습니다.");
    } finally {
      setArchitectBusy(false);
      setArchitectAction(null);
    }
  }

  async function requestGraphChange() {
    return requestGraphChangeWith(architectDraft.trim());
  }

  /** 같은 제안 흐름을 문장으로 바로 부른다(실패 카드의 "AI가 고치게 하기"가 쓴다). */
  async function requestGraphChangeWith(sentenceIn: string) {
    const api = ipc();
    if (!api || !automation) return;
    const sentence = sentenceIn.trim();
    if (!sentence) return;
    setArchitectBusy(true);
    setArchitectAction("propose");
    setProposal(null);
    setMessage(locale === "en" ? "Working out what would change..." : "무엇이 바뀔지 알아보는 중입니다...");
    try {
      const result = await api.automations.requestGraphPatch(automation.id, sentence);
      if (!result.ok) {
        // 실패는 사유와 다음 행동을 그대로 보여준다 — 코드만 남기지 않는다.
        setMessage(`${result.reason} ${result.nextAction}`);
        return;
      }
      setProposal(result);
      setMessage(locale === "en"
        ? "Nothing has changed yet. Review it and apply."
        : "아직 아무것도 바뀌지 않았습니다. 내용을 확인하고 적용하세요.");
    } catch {
      setMessage(locale === "en" ? "The change could not be worked out." : "변경 내용을 만들지 못했습니다.");
    } finally {
      setArchitectBusy(false);
      setArchitectAction(null);
    }
  }

  async function applyProposal() {
    const api = ipc();
    if (!api || !automation || !proposal) return;
    const previous = automation;
    setArchitectBusy(true);
    setArchitectAction("apply");
    try {
      const result = await api.automations.applyGraphPatch(previous.id, proposal.patch);
      if (!result.ok) {
        setMessage(`${result.reason ?? ""} ${result.nextAction ?? ""}`.trim() || (locale === "en" ? "Not applied." : "적용하지 못했습니다."));
        return;
      }
      const applied = exactAutomationProjection(result.automation, previous.id);
      if (result.automationId !== previous.id || !applied) throw new Error("automation_patch_receipt_mismatch");
      setProposal(null);
      setArchitectDraft("");
      setAutomation(applied);
      setMessage(locale === "en" ? "Applied." : "적용했습니다.");
    } catch {
      try {
        const current = exactAutomationProjection(await api.automations.get(previous.id), previous.id);
        if (!current) throw new Error("automation_patch_readback_missing");
        if (sameWorkflowGraph(current.graph, previous.graph)) {
          setMessage(locale === "en"
            ? "The saved graph still matches the graph from before this request. The proposal remains available to review."
            : "저장된 그래프는 요청 전과 같습니다. 제안은 계속 검토할 수 있도록 남겨뒀습니다.");
        } else {
          setAutomation(current);
          setProposal(null);
          setMessage(locale === "en"
            ? "The saved graph changed, but the lost reply makes it impossible to prove that this exact proposal caused it. Review the current graph and do not apply the proposal again."
            : "저장된 그래프는 바뀌었지만 응답이 유실되어 이 제안이 정확히 반영된 것인지 증명할 수 없습니다. 현재 그래프를 검토하고 제안을 다시 적용하지 마세요.");
        }
      } catch {
        setProposal(null);
        setMessage(locale === "en"
          ? "The proposal may already have changed the graph, but its final state could not be read. Do not apply it again; reopen this automation and inspect the saved graph."
          : "제안이 그래프를 이미 바꿨을 수 있으나 최종 상태를 읽지 못했습니다. 다시 적용하지 말고 자동화를 다시 열어 저장본을 확인하세요.");
      }
    } finally {
      setArchitectBusy(false);
      setArchitectAction(null);
    }
  }

  async function runNow(
    dryRun = false,
    inputValue?: string,
    fresh = false,
    reviewedFresh = false,
  ) {
    const api = ipc();
    if (!api || !automation) return;
    let requirement: Awaited<ReturnType<typeof api.automations.inputRequirement>> = null;
    // 시작 값을 받아야 하는 그래프는 값을 받고 나서 실행한다. 예전에는 그냥 시작해서
    // 빈 값으로 돌았고, 사용자는 결과를 열어보고서야 값이 빠진 걸 알았다.
    if (!dryRun) {
      // ★조회가 도는 동안에도 눌린 티가 나야 한다 — 값이 필요한 그래프에서는 이 await가
      //   유일하게 화면이 조용한 구간이었다.
      setRunning(true);
      setMessage(locale === "en" ? "Checking what it needs…" : "필요한 값을 확인하는 중입니다…");
      try {
        requirement = await api.automations.inputRequirement(automation.id);
      } catch {
        setRunning(false);
        setMessage(locale === "en"
          ? "The required start input could not be checked, so nothing ran. Check the connection and try again."
          : "실행에 필요한 시작 값을 확인하지 못해 아무것도 실행하지 않았습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
        return;
      }
      if (inputValue === undefined && requirement?.required) {
        setRunning(false);
        setInputPrompt({ label: requirement.label, value: "", fresh });
        setMessage("");
        return;
      }
    }
    if (fresh) {
      // A fresh run must be visibly distinct before Main accepts it. If the
      // safety gate rejects it, the catch path hydrates the durable failure
      // back into this view instead of hiding that record.
      setRunStates(Object.fromEntries((automation.graph?.nodes ?? []).map((node) => [node.id, "pending" as const])));
      setNodeProgress({});
      setNodeFailures({});
      setActivity([]);
      setRunStartedAt(null);
    }
    setRunning(true);
    setMessage(
      dryRun
        ? (locale === "en"
          ? "Starting a simulation. Nothing will be sent outside."
          : "시뮬레이션을 시작합니다. 바깥으로 나가는 작업은 실행되지 않습니다.")
        : (locale === "en" ? "Starting background run..." : "백그라운드 실행을 시작하는 중입니다..."),
    );
    const previousRun = await api.automations.latestRun(automation.id).catch(() => undefined);
    let result: Awaited<ReturnType<typeof api.automations.runNow>>;
    const runNowRequest = api.automations.runNow as unknown as (
      automationId: string,
      options?: { dryRun?: boolean; fresh?: boolean; input?: Record<string, unknown> },
    ) => Promise<Awaited<ReturnType<NonNullable<typeof api>["automations"]["runNow"]>>>;
    const runOptions = dryRun
      ? { dryRun: true }
      : {
        ...(requirement?.required && inputValue !== undefined
          ? { input: { [requirement.varName]: inputValue } }
          : {}),
        ...(fresh ? { fresh: true } : {}),
      };
    const reviewFreshAndRetry = async (): Promise<boolean> => {
      if (!fresh || reviewedFresh || !previousRun) return false;
      const currentRun = await api.automations.latestRun(automation.id).catch(() => null) as TerminalCloseRunSnapshot | null;
      if (!currentRun || currentRun.automationId !== automation.id
        || currentRun.runId !== previousRun.runId || currentRun.status !== "error") {
        return false;
      }
      let reconciliation: Awaited<ReturnType<typeof api.automations.getGraphReconciliation>>;
      let reconciliationRead = false;
      try {
        reconciliation = await api.automations.getGraphReconciliation(automation.id);
        reconciliationRead = true;
      } catch {
        // Graph drift can make the current reconciliation view unavailable.
        // The old checkpoint identity below still decides whether terminal
        // close is possible; unresolved nodes remain fail-closed.
        reconciliation = null;
      }
      if (reconciliation) return false;
      const latestRunUnresolvedNodeIds = [...new Set([
        ...(currentRun.inFlightNodeIds ?? []),
        ...(currentRun.ambiguousNodeIds ?? []),
      ])];
      const terminalCloseCandidateReader = (api.automations as unknown as {
        terminalCloseCandidate?: (automationId: string) => Promise<TerminalCloseCandidate | null>;
      }).terminalCloseCandidate;
      const terminalCloseCandidate = terminalCloseCandidateReader
        ? await terminalCloseCandidateReader(automation.id).catch(() => null)
        : null;
      const candidate = terminalCloseCandidate
        && terminalCloseCandidate.automationId === automation.id
        && terminalCloseCandidate.runId === currentRun.runId
        ? terminalCloseCandidate
        : null;
      const unresolvedNodeIds = candidate?.unresolvedNodeIds ?? latestRunUnresolvedNodeIds;
      if (unresolvedNodeIds.length > 0) {
        setMessage(locale === "en"
          ? `A fresh run was not started because unresolved external effects remain (${unresolvedNodeIds.join(", ")}). Verify the result, restore the old graph if needed, and reconcile it first.`
          : `미확정 외부 동작(${unresolvedNodeIds.join(", ")})이 남아 있어 새 실행을 시작하지 않았습니다. 실제 결과를 확인한 뒤 이전 그래프로 복원해 재조정해 주세요.`);
        return true;
      }
      const terminalCloseInput: TerminalCloseInput | null = candidate
        ? candidate.simulation === false
          ? {
            automationId: candidate.automationId,
            runId: candidate.runId,
            occurrenceId: candidate.occurrenceId,
            graphDigest: candidate.graphDigest,
            checkpointDigest: candidate.checkpointDigest,
            expectedUpdatedAt: candidate.updatedAt,
            decision: "reviewed_external_effects",
          }
          : null
        : currentRun.occurrenceId
        && currentRun.graphDigest
        && currentRun.checkpointDigest
        && currentRun.checkpointUpdatedAt
        ? {
          automationId: automation.id,
          runId: currentRun.runId,
          occurrenceId: currentRun.occurrenceId,
          graphDigest: currentRun.graphDigest,
          checkpointDigest: currentRun.checkpointDigest,
          expectedUpdatedAt: currentRun.checkpointUpdatedAt,
          decision: "reviewed_external_effects",
        }
        : null;
      if (!terminalCloseInput) {
        if (!reconciliationRead) {
          setMessage(locale === "en"
            ? "The old run checkpoint could not be read safely. No fresh run was started; restore the old graph before reconciling it."
            : "이전 실행의 체크포인트를 안전하게 읽지 못해 새 실행을 시작하지 않았습니다. 이전 그래프로 복원한 뒤 재조정해 주세요.");
          return true;
        }
        return false;
      }
      const confirmed = window.confirm(locale === "en"
        ? `Review run ${currentRun.runId} and confirm its external result before starting a separate run? Any action that already completed may happen again. The old run will remain in history.`
        : `${currentRun.runId} 실행의 외부 결과를 확인했습니까? 이미 완료된 동작은 새 실행에서 다시 일어날 수 있습니다. 이전 실행 기록은 남겨 둔 채 별도 실행을 시작합니다.`);
      if (!confirmed) return false;
      try {
        const terminalCloseApi = api.automations as unknown as {
          terminalClose?: (input: TerminalCloseInput) => Promise<TerminalCloseReceipt>;
          /** Temporary compatibility while an older preload is open. */
          terminalCloseGraph?: (input: TerminalCloseInput) => Promise<TerminalCloseReceipt>;
        };
        const terminalClose = terminalCloseApi.terminalClose ?? terminalCloseApi.terminalCloseGraph;
        if (!terminalClose) throw new Error("automation_graph_terminal_close_unavailable");
        const receipt = await terminalClose(terminalCloseInput);
        if (
          receipt.automationId !== terminalCloseInput.automationId
          || receipt.runId !== terminalCloseInput.runId
          || receipt.occurrenceId !== terminalCloseInput.occurrenceId
          || receipt.graphDigest !== terminalCloseInput.graphDigest
          || receipt.checkpointDigest !== terminalCloseInput.checkpointDigest
          || (receipt.status !== "closed" && receipt.status !== "already-closed")
        ) throw new Error("automation_graph_terminal_close_receipt_mismatch");
        setInputPrompt(null);
        setMessage(locale === "en"
          ? "The previous run was reviewed. Starting a separate occurrence…"
          : "이전 실행을 확인했습니다. 별도 발생을 새로 시작합니다…");
        await runNow(dryRun, inputValue, fresh, true);
        return true;
      } catch {
        setMessage(locale === "en"
          ? "The exact terminal-close receipt could not be verified. No separate run was started. Refresh the history; if the graph drifted, restore the old graph to reconcile it."
          : "해당 실행의 종결 영수증을 저장·검증하지 못해 별도 실행을 시작하지 않았습니다. 기록을 새로고침하고 그래프가 바뀌었다면 이전 그래프로 복원해 재조정해 주세요.");
        return true;
      }
    };
    try {
      result = await runNowRequest(
        automation.id,
        Object.keys(runOptions).length > 0 ? runOptions : undefined,
      );
      if (!result.accepted || result.automationId !== automation.id || !result.status) {
        throw new Error("automation_run_receipt_mismatch");
      }
    } catch (err) {
      try {
        const currentRun = await api.automations.latestRun(automation.id);
        const freshBlocked = fresh && /fresh_run_blocked|ambiguous_side_effect|reconciliation required/i.test(String(err));
        if (freshBlocked && await reviewFreshAndRetry()) return;
        if (currentRun && currentRun.automationId === automation.id && freshBlocked) {
          setInputPrompt(null);
          setRunStates(currentRun.nodeStates);
          applySnapshotFailures(currentRun.nodeFailures);
          setRunStartedAt(currentRun.startedAt);
          setMessage(locale === "en"
            ? "A fresh run was not started because the earlier run may have changed external state. Review the exact run and explicitly close it before starting a separate occurrence."
            : "이전 실행이 외부 상태를 바꿨을 수 있어 처음부터 새 실행을 시작하지 않았습니다. 해당 실행을 확인하고 명시적으로 종결한 뒤 별도 실행을 시작해 주세요.");
        } else if (currentRun && currentRun.automationId === automation.id && previousRun !== undefined && currentRun.runId !== previousRun?.runId) {
          setInputPrompt(null);
          setRunStates(currentRun.nodeStates);
          applySnapshotFailures(currentRun.nodeFailures);
          setRunStartedAt(currentRun.startedAt);
          setMessage(locale === "en"
            ? `A new run ${currentRun.runId} is in history with status ${currentRun.status}, but its reply was lost. Inspect that run and do not start another one just to check.`
            : `새 실행 ${currentRun.runId}이(가) 기록에 ${currentRun.status} 상태로 남아 있지만 응답이 유실됐습니다. 해당 실행을 확인하고 확인 목적으로 다시 실행하지 마세요.`);
        } else if (previousRun !== undefined && currentRun?.runId === previousRun?.runId) {
          if (fresh) {
            setRunStates(currentRun?.nodeStates ?? {});
            applySnapshotFailures(currentRun?.nodeFailures);
            setRunStartedAt(currentRun?.startedAt ?? null);
          }
          setMessage(locale === "en"
            ? "Run history still shows the same run as before this request. No new run was confirmed; inspect history before trying again."
            : "실행 기록에는 요청 전과 같은 실행만 보입니다. 새 실행은 확인되지 않았으니 다시 시도하기 전에 기록을 확인하세요.");
        } else {
          setMessage(locale === "en"
            ? "The run request may have started, but the returned receipt could not be matched to this action. Inspect run history and do not repeat it until you know the outcome."
            : "실행 요청이 시작됐을 수 있으나 반환 영수증을 이 작업과 일치시킬 수 없습니다. 결과를 알기 전에는 반복하지 말고 실행 기록을 확인하세요.");
        }
      } catch {
        setMessage(locale === "en"
          ? "The run request may have started, but its result and run history could not be read. Do not repeat it until the history is available."
          : "실행 요청이 시작됐을 수 있으나 결과와 실행 기록을 읽지 못했습니다. 기록을 확인할 수 있을 때까지 반복하지 마세요.");
      }
      setRunning(false);
      return;
    }
    setInputPrompt(null);
    const freshBlocked = fresh && result.status !== "ok"
      && /fresh_run_blocked|ambiguous_side_effect|reconciliation required/i.test(result.error ?? "");
    if (freshBlocked && await reviewFreshAndRetry()) return;
    const terminalMessage =
      freshBlocked
        ? (locale === "en"
          ? "A fresh run was not started because the earlier run may have changed external state. Review the exact run and explicitly close it before starting a separate occurrence."
          : "이전 실행이 외부 상태를 바꿨을 수 있어 처음부터 새 실행을 시작하지 않았습니다. 해당 실행을 확인하고 명시적으로 종결한 뒤 별도 실행을 시작해 주세요.")
        : result.status !== "ok"
        ? (result.error || (locale === "en"
          ? `Run ended with status ${result.status ?? "failed"}.`
          : `실행이 ${result.status ?? "실패"} 상태로 끝났습니다.`))
        : dryRun
        ? (locale === "en"
          ? "Simulation completed. External-changing steps were skipped and recorded."
          : "시뮬레이션을 완료했습니다. 바깥을 바꾸는 단계는 건너뛰고 기록했습니다.")
        : (locale === "en" ? "Run completed. The final steps and log are shown here." : "실행을 완료했습니다. 최종 단계와 기록을 이 화면에서 확인할 수 있습니다.");
    setMessage(terminalMessage);
    try {
      const snap = await api.automations.latestRun(automation.id);
      if (snap?.nodeStates) setRunStates(snap.nodeStates);
      applySnapshotFailures(snap?.nodeFailures);
      setRunStartedAt(snap?.startedAt ?? null);
    } catch {
      setMessage(locale === "en"
        ? `${terminalMessage} The run-history view could not refresh. Do not rerun solely to refresh this screen.`
        : `${terminalMessage} 실행 기록 화면을 새로고침하지 못했습니다. 이 화면 갱신만을 위해 다시 실행하지 마세요.`);
    } finally {
      setRunning(false);
    }
  }

  async function refreshRunView() {
    const api = ipc();
    if (!api || !automation || refreshing) return;
    setRefreshing(true);
    setMessage(locale === "en" ? "Refreshing the saved run state…" : "저장된 실행 상태를 새로 읽는 중입니다…");
    try {
      const snap = await api.automations.latestRun(automation.id);
      if (snap && snap.automationId !== automation.id) throw new Error("automation_refresh_identity_mismatch");
      if (snap) {
        setRunStates(snap.nodeStates ?? {});
        applySnapshotFailures(snap.nodeFailures);
        setRunStartedAt(snap.startedAt ?? null);
      } else if (!snap) {
        setRunStates({});
        setNodeFailures({});
        setRunStartedAt(null);
      }
      window.dispatchEvent(new CustomEvent("agentlas:automation-run-refresh", {
        detail: { automationId: automation.id },
      }));
      setMessage(locale === "en" ? "The saved run state was refreshed." : "저장된 실행 상태를 새로고침했습니다.");
    } catch {
      setMessage(locale === "en"
        ? "The saved run state could not be refreshed. No new run was started."
        : "저장된 실행 상태를 새로고침하지 못했습니다. 새 실행은 시작하지 않았습니다.");
    } finally {
      setRefreshing(false);
    }
  }

  if (loading || error || !automation) {
    return (
      <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
        <section style={{ maxWidth: 640, margin: "24px auto", padding: "0 24px" }}>
          <div style={{ ...noticeBox, display: "grid", gap: 6 }}>
            <span>{loading
              ? locale === "en" ? "Loading automation…" : "자동화를 불러오는 중입니다…"
              : error || (locale === "en" ? "Automation could not be opened." : "자동화를 열 수 없습니다.")}</span>
            {loading && <LoadingEstimate locale={locale} operationKey="desktop-automation-flow" expectedSeconds={[1, 25]} />}
          </div>
        </section>
      </div>
    );
  }

    /* ★상세(인스펙터)는 오른쪽 열이 아니라 하단 탭 하나다 — 오너 지시(2026-08-09):
     "바텀시트에 인스펙터를 띄우라… 겹친 세 가지를 탭으로, VS Code 터미널 탭처럼".
     한 상황을 두 자리에서 다른 말로 설명하던 것이 중복 효과(HE.md)였고,
     사용자는 어느 쪽을 눌러야 하는지 몰랐다. */
  /* ★결정이 필요한 것들(시작 값·승인 대기·판정 교정·의존성 수리)은 인스펙터와 한자리에.
     오너 지시(2026-08-09): "탭은 로그·대화만 두고 상세는 기존처럼 오른쪽 사이드바".
     하단 탭에 넣었더니 캔버스를 보면서 결정할 수 없었고, 편집 중에는 팔레트와 자리를
     다퉜다. 결정은 캔버스 옆에서, 로그·대화는 캔버스 아래에서. */
  const decisionCards = (
              <div
                style={{
                  padding: "8px 10px",
                  display: "grid",
                  gap: 8,
                  overflowY: "auto",
                }}
              >
      {/* 시작 값을 받아야 하는 그래프. 값을 받고 나서 실행한다 —
          묻지 않고 시작하면 빈 값으로 도는 것을 사용자가 결과에서야 알게 된다. */}
      {inputPrompt ? (
        <div
          data-testid="graph-input-prompt"
          style={{
            
            padding: "12px 14px", borderRadius: 12,
            border: "1px solid var(--line)", background: "var(--paper)",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{inputPrompt.label}</div>
          <input
            data-testid="graph-input-value"
            autoFocus
            value={inputPrompt.value}
            placeholder={locale === "en" ? "Type the value this run starts from" : "이번 실행이 시작할 값을 입력하세요"}
            onChange={(e) => setInputPrompt({ ...inputPrompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && inputPrompt.value.trim()) void runNow(false, inputPrompt.value.trim(), inputPrompt.fresh);
              if (e.key === "Escape") setInputPrompt(null);
            }}
            className="titlebar-nodrag"
            style={{
              padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)",
              background: "var(--paper-2)", color: "var(--ink)", fontSize: 13, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="graph-input-start"
              className="titlebar-nodrag"
              disabled={running || !inputPrompt.value.trim()}
              onClick={() => void runNow(false, inputPrompt.value.trim(), inputPrompt.fresh)}
              style={{ ...actionBtn, opacity: inputPrompt.value.trim() ? 1 : 0.5 }}
            >
              {locale === "en" ? "Start with this" : "이 값으로 실행"}
            </button>
            <button className="titlebar-nodrag" onClick={() => setInputPrompt(null)} style={pillBtn(false)}>
              {locale === "en" ? "Cancel" : "취소"}
            </button>
          </div>
        </div>
      ) : null}

      {/* 위 카드는 **사람이 누를 버튼이 있는 실패**만 띄운다(승인·판정 교정·의존성 수리).
          사유·경과 같은 정보성 실패는 하단 로그 패널이 전담한다 — 같은 실패가 위아래
          두 곳에 뜨면 어느 쪽이 진짜 행동 지점인지 알 수 없다(오너 지시 2026-08-06:
          "아래 만들었으면 위에 저거 없애야지"). */}
      {/* ★편집 중에는 실행 결정 카드를 이 탭에서 비운다. 지금 여기 있는 이유는
          "노드를 놓거나 고치려고"이고, 팔레트·노드 설정이 그 카드에 밀려 화면 밖으로
          내려가면 [노드 추가]를 눌러도 아무것도 안 나온 것처럼 보인다(실렌더 2026-08-09).
          결정은 사라지지 않는다 — 탭 배지와 상단 상태줄이 계속 부르고, 편집을 끝내면
          그 자리에 그대로 있다. */}
      {(editing ? [] : Object.entries(nodeFailures)).map(([failedNodeId, failure]) => {
        const nodeLabel = rfNodes.find((n) => n.id === failedNodeId)?.data?.label ?? failedNodeId;
        const evalStuck = failure.code === "EVAL_STUCK";
        // ★코드가 쓰는 파이썬 패키지를 준비 못 한 실패. 사람에게 pip 이름을 묻는 것은
        //   답이 아니다 — 코드를 지은 것은 AI이고, 사용자는 `PIL`의 pip 이름이
        //   `Pillow`라는 걸 알 이유가 없다(실측: PIL·sklearn 둘 다 죽었다).
        const depMissing = failure.code === "CODE_DEPENDENCY_MISSING";
        // 버튼 없는 실패는 카드가 아니라 로그 줄이다.
        if (!evalStuck && !depMissing) return null;
        return (
          <div
            key={failedNodeId}
            className="titlebar-nodrag"
            data-testid={`node-failure-${failedNodeId}`}
            style={{

              padding: "12px 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
              fontSize: 12,
              color: "var(--ink)",
              display: "grid",
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 600 }}>{String(nodeLabel)}</div>
            <div style={{ color: "var(--ink-soft)", lineHeight: 1.6 }}>{failure.reason}</div>
            <div style={{ color: "var(--muted-deep)", lineHeight: 1.6 }}>{failure.nextAction}</div>
            {/* ★"기준이 틀렸을 수도"의 두 갈래: 채점표를 고치거나(캔버스에서),
                판정이 틀렸다고 교정한다. 교정은 그 노드의 이후 판정에 few-shot으로
                주입된다 — 사람의 채점 감각이 그래프에 쌓이는 자리(5건이면 유의미). */}
            {depMissing ? (
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button
                  className="titlebar-nodrag"
                  data-testid="fix-dependency"
                  disabled={architectBusy}
                  onClick={() => {
                    // 그 단계 하나만 고치는 지시로 architect에 보낸다. 제안은 사람이 승인한다.
                    const scoped = locale === "en"
                      ? `The step "${nodeLabel}" (node id ${failedNodeId}) fails because a Python package it imports is not installed. Add the correct pip package name(s) to that step's packages field — the pip name often differs from the import name. Change nothing else.`
                      : `"${nodeLabel}" 단계(노드 id ${failedNodeId})가 쓰는 파이썬 패키지를 준비하지 못해 실패합니다. 그 단계의 packages에 올바른 pip 이름을 넣어 주세요 — pip 이름은 import 이름과 다를 때가 많습니다. 다른 것은 바꾸지 마세요.`;
                    setArchitectDraft(scoped);
                    void requestGraphChangeWith(scoped);
                  }}
                  style={pillBtn(true)}
                >
                  {architectBusy
                    ? (locale === "en" ? "Working…" : "고치는 중…")
                    : (locale === "en" ? "Have AI fix it" : "AI가 고치게 하기")}
                </button>
              </div>
            ) : null}

            {evalStuck ? (
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button
                  className="titlebar-nodrag"
                  onClick={() => {
                    void (async () => {
                      const api = ipc();
                      if (!api || !automation) return;
                      await api.automations.recordEvalCorrection(automation.id, failedNodeId, "pass");
                      setMessage(locale === "en"
                        ? "Recorded. Future judgments on this step will learn from this ruling."
                        : "기록했습니다. 이 단계의 다음 판정부터 이 교정을 배웁니다.");
                    })();
                  }}
                  style={pillBtn(false)}
                >
                  {t("auto.flow.eval_correct_pass")}
                </button>
              </div>
            ) : null}
            {/* 기계 코드는 사용자가 읽을 문장이 아니다. 지원에 붙여 넣을 때만 필요하므로
                기본은 접어 두고, 사유·행동이 카드의 주인공이 되게 한다. */}
            <details style={{ marginTop: 2 }}>
              <summary
                className="titlebar-nodrag"
                style={{ fontSize: 11, color: "var(--muted-deep)", cursor: "pointer", listStyle: "none" }}
              >
                {locale === "en" ? "Technical detail" : "기술 정보"}
              </summary>
              <div style={{ fontSize: 10, color: "var(--muted-deep)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
                {failure.code}
              </div>
            </details>
          </div>
        );
      })}
              </div>
  );

  const runtimePresentation = runtimeSelectionPresentation(automation.runtimeSelection, locale);

  const inspectorContent = (
    <>
          <div className="automation-inspector-bar">
            <span>{locale === "en" ? "Details" : "상세"}</span>
            <button
              type="button"
              onClick={() => setRightOpen(false)}
              aria-label={locale === "en" ? "Collapse details" : "상세 패널 접기"}
              title={locale === "en" ? "Collapse details" : "상세 패널 접기"}
            >
              ⟩
            </button>
          </div>
          {/* 결정이 필요한 것이 있으면 이 열의 맨 위에 온다 — 노드 설정보다 먼저 읽혀야 한다. */}
          {decisionCards}
          {editing && paletteOpen ? (
            <NodePalette onAdd={addPaletteNode} onClose={() => setPaletteOpen(false)} />
          ) : editing && selectedEdge ? (
            <LoopBoundPanel
              isBackEdge={backEdgeIds.has(selectedEdge.id)}
              value={(selectedEdge.data as { maxIterations?: number } | undefined)?.maxIterations ?? null}
              onChange={setLoopBound}
              onClose={() => setSelectedEdgeId(null)}
              onDelete={() => {
                const edgeId = selectedEdge.id;
                setRfEdges((eds) => eds.filter((e) => e.id !== edgeId));
                setSelectedEdgeId(null);
                setDirty(true);
              }}
              locale={locale}
            />
          ) : editing && selectedNode ? (
            <NodeConfigPanel node={selectedNode} onPatch={patchSelected} onLabel={labelSelected} onDelete={deleteSelected} onClose={() => setSelectedNodeId(null)} timezone={automation?.timezone ?? null} automationId={automation?.id} />
          ) : selectedNode ? (
            <NodeInspector node={selectedNode} onClose={() => setSelectedNodeId(null)} t={t} />
          ) : (
            <div className="automation-node-empty" data-one-content-slot />
          )}
          <RunHistoryPanel
            automation={automation}
            locale={locale}
            compact
          />
        </>
  );

return (
    <div className="automation-flow-screen" style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--paper-2)", minHeight: 0, position: "relative" }}>
      <header
        className="automation-flow-header titlebar-drag"
        style={{
          padding: "14px 20px 14px 32px",
          minHeight: 56,
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
        }}
      >
        <div className="automation-flow-header-title">
          <IconBolt size={18} style={{ color: automation.enabled ? "var(--accent)" : "var(--muted)", flexShrink: 0 }} />
        {/* 이름이 제목의 본체다. 0까지 줄어들면 "Ho/on/the/hour"처럼 한 글자씩
            무너지고, 바닥이 너무 낮으면(160px) 이번엔 "X AI Ag…"로 잘린다. 헤더가
            어차피 가로 스크롤되므로 여기서는 줄이지 않는다 — 이름은 온전히 보이고,
            모자란 폭은 스크롤이 흡수한다. */}
        <div style={{ minWidth: 0, maxWidth: 360 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {automation.name}
          </h1>
          {/* ★크론 원문(`0 9 * * 1`)을 그대로 보여주지 않는다 — humanSchedule이 이미
              사람 말로 바꿀 줄 아는데 이 자리만 안 쓰고 있었다(실사용 실측).
              nowrap이 없으면 "Hourly, on the / hour"로 접혀 헤더 높이가 흔들린다. */}
          <div style={{ fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {humanSchedule(automation.scheduleHuman, locale)}
            <span
              data-testid="automation-runtime-chip"
              title={`${runtimePresentation.label} · ${runtimePresentation.detail}`}
              style={{
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "flex-start",
                marginLeft: 8,
                padding: "2px 7px",
                borderRadius: 999,
                border: "1px solid var(--paper-edge)",
                color: "var(--ink-soft)",
                background: "var(--paper-2)",
                fontWeight: 600,
              }}
            >
              <strong>{runtimePresentation.label}</strong>
              <small>{runtimePresentation.detail}</small>
            </span>
          </div>
        </div>
        </div>

        <div className="automation-flow-header-actions">
        {editing ? (
          <>
            <button onClick={() => setPaletteOpen((v) => !v)} className="titlebar-nodrag" style={pillBtn(paletteOpen)}>
              {t("auto.flow.add_node")}
            </button>
            <button onClick={autoLayoutCanvas} className="titlebar-nodrag" style={pillBtn(false)}>
              {locale === "en" ? "Auto layout" : "자동 정렬"}
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !dirty || errorCount > 0}
              title={errorCount > 0 ? t("auto.validate.blocked") : undefined}
              className="titlebar-nodrag"
              style={{ ...actionBtn, opacity: saving || !dirty || errorCount > 0 ? 0.55 : 1 }}
            >
              {t("auto.flow.save")}
            </button>
            <button onClick={() => { setEditing(false); setPaletteOpen(false); void load(); }} className="titlebar-nodrag" style={pillBtn(false)}>
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => router.push(`/automation/new?id=${encodeURIComponent(automation.id)}`)} className="titlebar-nodrag" style={pillBtn(false)}>
              {t("auto.flow.edit_meta")}
            </button>
            <button
              data-testid="change-automation-model"
              onClick={() => router.push(`/automation/new?id=${encodeURIComponent(automation.id)}#execution-ai`)}
              className="titlebar-nodrag"
              style={{ ...pillBtn(Boolean(automation.runtimeSelection)), borderColor: "var(--accent-soft)" }}
              title={locale === "en" ? "Change the model used by this automation" : "이 자동화가 사용할 모델을 변경합니다"}
            >
              {locale === "en" ? "Change model" : "모델 변경"}
            </button>
            <button onClick={() => setEditing(true)} className="titlebar-nodrag" style={pillBtn(false)}>
              {t("auto.flow.edit")}
            </button>
            {/* 연결이 빠져 있으면 나머지가 다 무의미하다 — 시뮬레이션·실행보다 앞에 둔다. */}
            <button
              data-testid="open-connections"
              onClick={() => setConnectionsOpen(true)}
              className="titlebar-nodrag"
              style={pillBtn(false)}
              title={locale === "en"
                ? "See what this automation uses, and connect it — one account opens every tool on it."
                : "이 자동화가 쓰는 것을 보고 연결합니다. 계정 하나로 그 계정의 도구가 함께 열립니다."}
            >
              {locale === "en" ? "Connections" : "연결"}
            </button>
            <button
              onClick={() => void publishToHub()}
              disabled={publishing}
              className="titlebar-nodrag"
              style={{ ...pillBtn(false), opacity: publishing ? 0.55 : 1 }}
              title={locale === "en"
                ? "Put this graph on the Hub so other people can install and run it."
                : "이 그래프를 Hub에 올려 다른 사람이 받아 쓸 수 있게 합니다."}
            >
              {publishing
                ? (locale === "en" ? "Publishing…" : "올리는 중…")
                : (locale === "en" ? "Publish to Hub" : "Hub에 올리기")}
            </button>
            <button
              onClick={() => void openVersions()}
              className="titlebar-nodrag"
              style={pillBtn(versionsOpen)}
              title={locale === "en"
                ? "Every save keeps the previous version — go back to one if an edit made things worse."
                : "저장할 때마다 직전 판이 남습니다. 고쳤다가 더 나빠지면 그 판으로 돌아갈 수 있습니다."}
            >
              {locale === "en" ? "History" : "이전 판"}
            </button>
            <button
              type="button"
              data-testid="refresh-automation-run"
              onClick={() => void refreshRunView()}
              disabled={refreshing}
              className="titlebar-nodrag"
              style={{ ...pillBtn(false), opacity: refreshing ? 0.55 : 1 }}
              title={locale === "en"
                ? "Read the saved run snapshot and history again. This does not start a run."
                : "저장된 실행 스냅샷과 기록만 다시 읽습니다. 실행은 시작하지 않습니다."}
            >
              <IconRefresh size={13} style={{ marginRight: 4 }} />
              {refreshing ? (locale === "en" ? "Refreshing…" : "새로 읽는 중…") : (locale === "en" ? "Refresh" : "새로고침")}
            </button>
            <button
              onClick={() => void runNow(true)}
              disabled={running}
              className="titlebar-nodrag"
              style={pillBtn(false)}
              title={locale === "en"
                ? "Run without sending anything outside, then see what a real run would have done."
                : "바깥으로 아무것도 내보내지 않고 돌려본 뒤, 실전이었으면 무엇이 일어났을지 봅니다."}
            >
              {t("auto.flow.simulate")}
            </button>
            {/* ★멈춘 실행이 남아 있으면 이 버튼은 처음부터가 아니라 **이어서** 돈다
                (run-graph 가 같은 occurrence 체크포인트에서 재개한다). 이름이 그 사실을
                말하지 않아 오너가 "첨부터 실행되는건지 모르겠"다고 했다 — 이름을
                하는 일에 맞춘다(HE.md 기대와의 일치성). */}
            <button
              onClick={() => void runNow()}
              disabled={running}
              className="titlebar-nodrag"
              title={resumable
                ? (locale === "en"
                  ? "Continues the stopped run from where it stopped — finished steps do not run twice."
                  : "멈춘 그 자리부터 이어서 돕니다. 이미 끝난 단계는 다시 실행되지 않습니다.")
                : undefined}
              style={{ ...actionBtn, color: running ? "var(--muted-deep)" : "var(--ink)" }}
            >
              {running
                ? <SpinnerLabel text={t("auto.flow.running")} />
                : resumable
                  ? (locale === "en" ? "Continue run" : "이어서 실행")
                  : t("auto.flow.run_now")}
            </button>
            {freshStartable ? (
              <button
                type="button"
                data-testid="fresh-automation-run"
                onClick={() => void runNow(false, undefined, true)}
                disabled={running || liveRunning}
                className="titlebar-nodrag"
                style={{ ...pillBtn(false), opacity: running || liveRunning ? 0.55 : 1 }}
                title={locale === "en"
                  ? "Start a separate run from the first step. An unresolved external effect will block it until reconciled."
                  : "첫 단계부터 별도 실행을 시작합니다. 외부 동작이 미확정이면 재조정할 때까지 시작하지 않습니다."}
              >
                {locale === "en" ? "Start fresh" : "처음부터 새 실행"}
              </button>
            ) : null}
            {/* ★도는 것을 사람이 멈춘다. 자동화는 사람이 안 볼 때 도는 것이라,
                봤을 때 세울 수 있어야 한다(다른 기능은 전부 취소가 있었다). */}
            {liveRunning ? (
              <button
                data-testid="stop-run"
                className="titlebar-nodrag"
                disabled={stopping}
                onClick={() => {
                  void (async () => {
                    const api = ipc();
                    if (!api || !automation) return;
                    setStopping(true);
                    setMessage(locale === "en" ? "Stopping…" : "멈추는 중입니다…");
                    try {
                      const r = await api.automations.stopRun(automation.id);
                      setMessage(r.stopped
                        ? (locale === "en"
                          ? "Stopping. Steps already sent outside are left for you to confirm."
                          : "멈춥니다. 이미 바깥으로 나간 단계는 확인할 수 있게 남겨 둡니다.")
                        : (locale === "en" ? "There is nothing running right now." : "지금 도는 실행이 없습니다."));
                    } finally {
                      setStopping(false);
                    }
                  })();
                }}
                style={pillBtn(false)}
              >
                {stopping
                  ? <SpinnerLabel text={locale === "en" ? "Stopping…" : "멈추는 중…"} />
                  : (locale === "en" ? "Stop" : "중지")}
              </button>
            ) : null}
            <button
              data-testid="toggle-enabled"
              onClick={() => void toggleEnabled()}
              className="titlebar-nodrag"
              disabled={toggling}
              style={{ ...pillBtn(automation.enabled), ...(toggling ? { opacity: 0.6, cursor: "default" } : {}) }}
              title={!automation.enabled && blockedByConnections
                ? (locale === "en" ? "Connect what it uses first." : "쓰는 것을 먼저 연결해야 켜집니다.")
                : undefined}
            >
              {toggling
                ? <SpinnerLabel text={automation.enabled
                  ? (locale === "en" ? "Turning off…" : "끄는 중…")
                  : (locale === "en" ? "Turning on…" : "켜는 중…")} />
                : automation.enabled
                  ? t("auto.action.disable")
                  : blockedByConnections
                    ? (locale === "en" ? "Connect to turn on" : "연결해야 켜집니다")
                    : t("auto.action.enable")}
            </button>
          </>
        )}
        </div>
      </header>
      {architectBusy ? (
        <div className="automation-architect-loading titlebar-nodrag" role="status" aria-live="polite">
          <span className="automation-architect-loading-spinner" aria-hidden="true" />
          <div>
            <strong>{architectAction === "apply"
              ? (locale === "en" ? "Applying the graph change" : "그래프 변경을 적용하는 중")
              : (locale === "en" ? "Preparing a graph change" : "그래프 개선안을 만드는 중")}</strong>
            <LoadingEstimate
              locale={locale}
              operationKey={architectAction === "apply" ? "automation-graph-apply" : "automation-graph-proposal"}
              expectedSeconds={architectAction === "apply" ? [1, 12] : [3, 35]}
              compact
            />
          </div>
        </div>
      ) : null}

      {/* ★상태 한 줄 — 화면에서 "지금 무슨 일이 일어났고 무엇을 누르면 되는가"의 유일한 답.
          편집 중에는 뜨지 않는다(그때의 관심사는 실행이 아니라 그래프다). */}
      {!editing ? (
        <div
          className="automation-run-status"
          data-tone={liveRunning ? "run" : stopped ? "stop" : "idle"}
          data-testid="run-status-strip"
        >
          <span className="automation-run-status-dot" aria-hidden="true" />
          <span className="automation-run-status-text">
            {liveRunning
                ? (locale === "en"
                  ? `Running${runningNodeLabel ? ` — ${runningNodeLabel}` : ""} · ${doneNodes}/${totalNodes} done`
                  : `실행 중${runningNodeLabel ? ` — ${runningNodeLabel}` : ""} · ${totalNodes}단계 중 ${doneNodes}단계 완료`)
                : stopped
                  ? (locale === "en"
                    ? `Stopped · ${doneNodes}/${totalNodes} done. What stopped it is in Details on the right.`
                    : `멈춰 있습니다 · ${totalNodes}단계 중 ${doneNodes}단계 완료. 무엇 때문인지는 오른쪽 [상세]에 있습니다.`)
                  : runStartedAt
                    // ★"안 돌고 있다"만 말하면 사용자는 "그래서 지난번엔 어떻게 됐는데?"를
                    //   또 찾아 헤맨다(평가의 간극). 마지막 실행 결과를 여기서 끝낸다.
                    ? (locale === "en"
                      ? `Last run ${new Date(runStartedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${doneNodes}/${totalNodes} steps done`
                      : `마지막 실행 ${new Date(runStartedAt).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${totalNodes}단계 중 ${doneNodes}단계 완료`)
                    : (locale === "en" ? "Not run yet — press Run now to try it once." : "아직 실행한 적이 없습니다 — [지금 실행]으로 한 번 돌려볼 수 있습니다.")}
          </span>
          {/* 주 행동은 언제나 **하나**, 그리고 아래 [상세]가 이미 그 카드를 펼쳐 놓았으면
              여기는 아무 버튼도 두지 않는다: 같은 행동이 두 군데 있으면 사용자는 둘이
              다른 일을 한다고 읽는다(오너 지적 "지금 다시 실행이 왜 2개나 있고"). */}
          {detailsShown ? null : stopped && !liveRunning ? (
            <button
              type="button"
              data-testid="status-open-details"
              className="automation-run-status-action"
              onClick={() => setRightOpen(true)}
            >
              {locale === "en" ? "Open Details" : "상세 열기"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 알림·제안·결정 카드는 캔버스 **위에 뜬다**. 예전에는 캔버스 위쪽에 차곡차곡 쌓여서,
          카드가 하나 늘 때마다 그래프가 아래로 밀리고 좁아졌다 — 화면의 주인공이
          부수 메시지에 밀려 가장 작은 영역을 갖는 상태였다. */}
      {connectionsOpen ? (
        <ConnectionsDialog
          automationId={automation.id}
          locale={locale}
          onClose={() => setConnectionsOpen(false)}
        />
      ) : null}

      {/* ★이전 판 목록. 되돌리기도 저장이므로 지금 판이 먼저 이력에 남는다 —
          되돌린 게 잘못이었을 때 다시 앞으로 올 수 있어야 한다. */}
      {versionsOpen ? (
        <div
          className="titlebar-nodrag"
          onClick={() => setVersionsOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.28)", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            data-testid="graph-versions"
            style={{ width: 460, maxHeight: "70vh", overflow: "auto", background: "var(--paper)", border: "var(--hairline)", borderRadius: 12, padding: 18 }}
          >
            <h2 style={{ margin: "0 0 4px", fontFamily: "var(--font-head)", fontSize: 15 }}>
              {locale === "en" ? "Earlier versions" : "이전 판"}
            </h2>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--muted-deep)" }}>
              {locale === "en"
                ? "A version is kept each time you save. Going back is itself a save, so the one you are on now stays too."
                : "저장할 때마다 직전 판이 남습니다. 되돌리는 것도 저장이라, 지금 판도 목록에 남습니다."}
            </p>
            {versions.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
                {locale === "en" ? "No earlier version yet — the first one appears after your next save." : "아직 이전 판이 없습니다. 다음 저장부터 남습니다."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {versions.map((v) => (
                  <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "var(--hairline)", borderRadius: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12 }}>{new Date(v.savedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                      <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                        {(locale === "en" ? `${v.nodeCount} steps` : `${v.nodeCount}단계`)}
                        {v.note ? ` · ${v.note}` : ""}
                      </div>
                    </div>
                    <button
                      onClick={() => void restoreVersion(v.id)}
                      disabled={!!restoring}
                      style={{ ...pillBtn(false), opacity: restoring ? 0.55 : 1 }}
                    >
                      {restoring === v.id
                        ? (locale === "en" ? "Restoring…" : "되돌리는 중…")
                        : (locale === "en" ? "Restore" : "이 판으로")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 14, textAlign: "right" }}>
              <button onClick={() => setVersionsOpen(false)} style={pillBtn(false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="automation-flow-overlay-anchor">
      <div className="automation-flow-overlay">

      {cuaPerm && !cuaPerm.ok ? (
        <div
          className="titlebar-nodrag"
          data-testid="cua-permission-card"
          style={{
            order: 2, padding: "12px 14px", borderRadius: "var(--radius-md)",
            border: "1px solid var(--accent-soft)", background: "var(--paper)", fontSize: 12,
            display: "grid", gap: 8,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {locale === "en"
              ? "This automation drives the screen, and macOS has not granted this app copy that permission."
              : "이 자동화는 화면을 조작하는데, macOS가 이 앱 실행본에 그 권한을 주지 않았습니다."}
          </div>
          <div style={{ color: "var(--muted-deep)" }}>
            {locale === "en"
              ? "If you already turned it on, it may be for a different copy — the installed app and a dev run count as different apps."
              : "이미 켰다면 다른 실행본에 켰을 수 있습니다 — 설치본과 개발 실행은 서로 다른 앱으로 취급됩니다."}
            {" "}({cuaPerm.missing.join(" · ")})
          </div>
          <div>
            <button
              onClick={() => void ipc()?.automations.openAccessibilitySettings()}
              style={pillBtn(false)}
            >
              {locale === "en" ? "Open the exact Settings pane" : "설정 화면 바로 열기"}
            </button>
          </div>
        </div>
      ) : null}

      {/* ★상태 문구("저장했습니다" 등)는 더 이상 떠 있는 카드가 아니다 — 캔버스를 가려
          클릭을 막았다(오너 실측 2026-08-08). 하단 통합 패널의 헤더 줄이 말한다. */}




      </div>
      </div>

      {/* ★세션 대화는 별도 열이 아니라 하단 통합 패널 안에 산다(오너 지시 2026-08-08:
          "세션대화도 없애고 아래 바텀시트로 모든 기능 통합"). 왼쪽 열이 사라진 만큼
          캔버스가 전체 폭을 쓴다. */}
      <div className="automation-flow-workspace">
        <div className="automation-flow-canvas">

          {isSynthesized && !editing ? (
            <div
              className="automation-flow-origin-note"
            >
              {t("auto.flow.synthesized")}
            </div>
          ) : null}
          <ReactFlow
            className="automation-flow-react"
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={workflowNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
            fitViewOptions={FIT_VIEW}
            minZoom={0.3}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={editing}
            nodesConnectable={editing}
            elementsSelectable
            deleteKeyCode={editing ? ["Backspace", "Delete"] : null}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, e) => { setSelectedEdgeId(e.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
          >
            <Background color="var(--paper-edge)" gap={24} size={1} />
            <Controls showInteractive={false} />
            {/* 미니맵 삭제(실측 항목 6) — 자리만 차지하고 캔버스 우하단을 가렸다.
                검증 결과는 아래 로그 패널이 담당한다. */}
          </ReactFlow>
          {aiNote ? (
            <div className="automation-ai-note-pop titlebar-nodrag" role="dialog" aria-label="AI note">
              <div className="automation-ai-note-title">
                {locale === "en" ? `Tell AI about “${aiNote.label}”` : `“${aiNote.label}” 단계에 메모`}
              </div>
              <textarea
                autoFocus
                value={aiNote.text}
                onChange={(e) => setAiNote({ ...aiNote, text: e.target.value })}
                placeholder={locale === "en"
                  ? "e.g. keep it under 200 characters, always include a source link"
                  : "예: 200자 이내로, 출처 링크는 꼭 포함"}
              />
              <div className="automation-ai-note-actions">
                <button type="button" onClick={() => setAiNote(null)}>{locale === "en" ? "Close" : "닫기"}</button>
                <button type="button" onClick={saveAiNote} disabled={!aiNote.text.trim()}>
                  {locale === "en" ? "Save note" : "주석 저장"}
                </button>
                <button type="button" data-primary onClick={() => void aiSetNode()} disabled={!aiNote.text.trim() || architectBusy}>
                  {locale === "en" ? "Have AI set this step" : "AI로 바로 세팅"}
                </button>
              </div>
              <p>
                {locale === "en"
                  ? "Save keeps the note on the step for the AI to read. “Have AI set this step” proposes a change to this step only — nothing applies until you approve it."
                  : "주석 저장은 이 단계에 메모로 남습니다(AI가 읽는 메모). “AI로 바로 세팅”은 이 단계만 고치는 제안을 만들고, 승인 전에는 아무것도 바뀌지 않습니다."}
              </p>
            </div>
          ) : null}
          {/* ★검증 로그 패널 — 에러·경고를 상단 팝업이 아니라 VS Code 하단 패널처럼.
              위 팝업은 캔버스를 밀어내고, 읽기 전에 사라지고, 줄이 많으면 잘렸다. */}
          {/* ★편집 중에도 이 패널이 있어야 한다 — 팔레트·노드 설정이 [상세] 탭에 살기
              때문이다. 예전 조건(`!editing || logRows.length > 0`)이면 검증 이슈가 하나도
              없는 정상 편집 상태에서 패널 자체가 렌더되지 않아, [노드 추가]를 눌러도
              팔레트가 갈 곳이 없었다 — 눌러도 아무 일이 없는 버튼(게이트 실측 2026-08-09). */}
          {(!editing || Boolean(message) || dirty || logRows.length > 0 || paletteOpen || selectedNodeId || selectedEdgeId) ? (
            /* ★터미널처럼 한 패널 — 로그가 위, 챗 입력이 아래 고정(오너 지시: 플로팅 금지·합치기). */
            <div className="automation-issue-log titlebar-nodrag" style={{ height: logOpen ? logHeight : (editing ? 30 : 92), display: "flex", flexDirection: "column" }}>
              <div
                className="automation-issue-log-grip"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = logHeight;
                  const move = (ev: MouseEvent) => {
                    setLogHeight(Math.min(420, Math.max(64, startH + (startY - ev.clientY))));
                    setLogOpen(true);
                  };
                  const up = () => {
                    window.removeEventListener("mousemove", move);
                    window.removeEventListener("mouseup", up);
                  };
                  window.addEventListener("mousemove", move);
                  window.addEventListener("mouseup", up);
                }}
              />
              {/* ★탭 바 — VS Code 터미널 탭. 탭을 누르면 그 탭이 열리고, 이미 열린
                  탭을 다시 누르면 접힌다. 주의가 필요한 탭은 숫자·점으로 스스로 부른다. */}
              <div className="automation-bottom-tabs">
                {([
                  { id: "session" as const, label: locale === "en" ? "Chat" : "대화", badge: 0 },
                  { id: "log" as const, label: locale === "en" ? "Log" : "로그", badge: errorCount + warnCount },
                ]).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="automation-bottom-tab titlebar-nodrag"
                    data-active={bottomTab === tab.id && logOpen ? "true" : undefined}
                    onClick={() => {
                      if (bottomTab === tab.id && logOpen) { setLogOpen(false); return; }
                      setBottomTab(tab.id);
                      setLogOpen(true);
                    }}
                  >
                    {tab.label}
                    {tab.badge > 0 ? <em>{tab.badge}</em> : null}
                  </button>
                ))}
                {/* 상태 문구는 여기(터미널 상태줄) — 떠 있는 카드로 캔버스를 가리지 않는다. */}
                {(message || (editing && dirty)) ? (
                  <span className="automation-bottom-status">{message || t("auto.flow.unsaved")}</span>
                ) : null}
                <button
                  type="button"
                  className="automation-bottom-collapse titlebar-nodrag"
                  onClick={() => setLogOpen((v) => !v)}
                  aria-label={logOpen ? (locale === "en" ? "Collapse panel" : "패널 접기") : (locale === "en" ? "Expand panel" : "패널 펼치기")}
                >
                  {logOpen ? "▾" : "▴"}
                </button>
              </div>
              {logOpen && bottomTab === "log" ? (
                <ul className="automation-issue-log-list">
                  {logRows.map((iss, i) => (
                    <li key={`iss-${i}`} data-severity={iss.severity}>
                      {/* 줄을 누르면 그 노드가 선택된다 — 어디 문제인지 찾아 헤매지 않게. */}
                      <button
                        type="button"
                        onClick={() => { if (iss.nodeId) { setSelectedNodeId(iss.nodeId); setSelectedEdgeId(null); } }}
                      >
                        <b>{iss.severity === "error" ? (locale === "en" ? "ERROR" : "오류") : (locale === "en" ? "WARN" : "경고")}</b>
                        {iss.message}
                      </button>
                    </li>
                  ))}
                  {/* ★실제 진행 — 커널이 보내는 사실을 시간순으로 다 적는다.
                      시각은 tabular-nums 로 자리를 고정한다(줄마다 흔들리면 못 읽는다). */}
                  {/* ★최신이 먼저다. 시간순 정렬은 유지하되 역순으로 그린다 — 로그 창을
                      연 사람이 찾는 것은 "방금 무슨 일이 있었나"이지 첫 줄이 아니다
                      (실사용 지적: 열 때마다 맨 위 과거부터 보였다). gap 은 아래 줄
                      (시간상 직전 행)과의 간격으로 계산해 의미를 지킨다. */}
                  {[...activity].reverse().map((row, idx) => {
                    const i = activity.length - 1 - idx;
                    const prev = i > 0 ? activity[i - 1] : null;
                    const gap = prev ? row.at - prev.at : 0;
                    return (
                      <li key={`act-${row.id}`} className="automation-activity-row" data-tone={row.tone}>
                        <button
                          type="button"
                          onClick={() => { if (row.nodeId) { setSelectedNodeId(row.nodeId); setSelectedEdgeId(null); } }}
                        >
                          {/* ko-KR 의 toLocaleTimeString 은 hour12:false 여도 "8시 47분 55초"를 낸다 —
                              로그는 훑는 것이라 자릿수가 고정된 HH:MM:SS 여야 한다. */}
                          <time>{new Date(row.at).toTimeString().slice(0, 8)}</time>
                          <b>{row.label}</b>
                          <span>{row.text}</span>
                          {gap >= 1000 ? <i>+{(gap / 1000).toFixed(1)}s</i> : null}
                        </button>
                      </li>
                    );
                  })}
                  {activity.length === 0 && logRows.length === 0 ? (
                    <li className="automation-activity-empty">
                      {locale === "en"
                        ? "Nothing has run yet. Each step, tool call and stop is written here as it happens."
                        : "아직 돌린 것이 없습니다. 실행하면 단계·도구 호출·멈춘 지점이 일어나는 대로 여기에 적힙니다."}
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {/* ★행동이 필요한 카드(시작 값·승인·판정 교정·의존성 수리)는 전부 이 패널 안에서
                  해결한다(오너 지시 2026-08-08: 플로팅 금지, 바텀시트 하나로). */}
              {/* 결정이 필요한 실패(승인 대기 등)와 인스펙터는 같은 탭에 산다 —
                  "확인이 필요한 것"이 한 자리에 있어야 사람이 헤매지 않는다. */}
              {/* ★세션 대화 스트림 — 별도 열이 아니라 이 패널 안에서 흐른다.
                  실행 기록·질문 카드·어시스턴트 응답이 로그와 같은 자리에서 이어진다. */}
              {!editing ? (
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    overflow: "hidden",
                    display: logOpen && bottomTab === "session" ? "flex" : "none",
                    flexDirection: "column",
                  }}
                >
                  <AutomationSessionPanel
                    automationId={automation.id}
                    locale={locale}
                    toolMode={automation.toolMode}
                    hubMode={automation.hubMode}
                    executionPermission={automation.executionPermission}
                    embedded
                    sendHandleRef={sessionSendRef}
                  />
                </div>
              ) : null}
              {!editing ? (
                <div className="automation-architect-composer" style={{ marginTop: "auto", padding: "8px 64px 16px 10px", borderTop: "1px solid var(--paper-edge)", background: "var(--paper)", display: logOpen && bottomTab === "session" ? "grid" : "none", gap: 8 }}>

              {!editing ? (
                <div
                  className="titlebar-nodrag"
                  style={{ display: "grid", gap: 8, order: 4 }}
                >
                  <input
                    ref={architectFileInputRef}
                    type="file"
                    multiple
                    accept="*/*"
                    tabIndex={-1}
                    aria-hidden="true"
                    style={{ display: "none" }}
                    onChange={(event) => { if (event.target.files) addArchitectFiles(event.target.files); }}
                  />
                  {architectAttachments.length > 0 ? (
                    <div className="automation-architect-attachments" aria-label={locale === "en" ? "Selected attachments" : "선택한 첨부 파일"}>
                      {architectAttachments.map((file, index) => (
                        <span key={`${file.name}-${file.size}-${index}`}>
                          <b>{file.name}</b>
                          <button
                            type="button"
                            aria-label={locale === "en" ? `Remove ${file.name}` : `${file.name} 제거`}
                            onClick={() => setArchitectAttachments((current) => current.filter((_, i) => i !== index))}
                          ><IconClose size={11} /></button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {architectAttachmentError ? <div className="automation-architect-attachment-error" role="alert">{architectAttachmentError}</div> : null}
                  <div className="automation-architect-input-row">
                    <button
                      type="button"
                      className="automation-architect-attach titlebar-nodrag"
                      onClick={() => architectFileInputRef.current?.click()}
                      disabled={architectBusy}
                      aria-label={locale === "en" ? "Attach photos, videos, or files" : "사진, 영상 또는 파일 첨부"}
                      title={locale === "en" ? "Attach files" : "파일 첨부"}
                    ><IconPaperclip size={16} /></button>
                    <textarea
                      ref={architectInputRef}
                      rows={1}
                      value={architectDraft}
                      onChange={(e) => setArchitectDraft(e.target.value)}
                      onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files ?? []);
                        if (files.length > 0) {
                          event.preventDefault();
                          addArchitectFiles(files);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          // ★Enter = 세션 대화로 보낸다(묻기·지시). 그래프 수정 제안은
                          //   옆의 [고칠 내용 보기] 버튼이 담당한다 — 입력은 하나, 행동은 둘.
                          const text = architectDraft.trim();
                          if (!text && architectAttachments.length === 0) return;
                          if (sessionSendRef.current) {
                            sessionSendRef.current(text, architectAttachments, () => {
                              setArchitectDraft("");
                              setArchitectAttachments([]);
                            });
                          } else {
                            void requestGraphChange();
                          }
                        }
                      }}
                      placeholder={t("auto.flow.architect_placeholder")}
                      disabled={architectBusy}
                    />
                    {/* ★기본 버튼은 입력창이 하는 일을 그대로 한다 — 보내기.
                        예전에는 이 자리에 [고칠 내용 보기]가 있어서, 채팅 입력 옆의
                        기본 버튼이 전혀 다른 동작(그래프 수정 제안)을 했다. 기대와의
                        일치성 위반(HE.md) — 입력창 옆 버튼은 Send 다. */}
                    <button
                      className="titlebar-nodrag"
                      disabled={architectBusy || (!architectDraft.trim() && architectAttachments.length === 0)}
                      onClick={() => {
                        const text = architectDraft.trim();
                        if (!text && architectAttachments.length === 0) return;
                        if (sessionSendRef.current) {
                          sessionSendRef.current(text, architectAttachments, () => {
                            setArchitectDraft("");
                            setArchitectAttachments([]);
                          });
                          return;
                        }
                        void requestGraphChange();
                      }}
                      style={actionBtn}
                    >
                      {t("auto.flow.session_send")}
                    </button>
                    {/* 그래프를 고치는 것은 보내기와 다른 일이므로 보조 자리에서
                        자기 이름으로 선다. */}
                    <button
                      className="titlebar-nodrag"
                      disabled={architectBusy || !architectDraft.trim()}
                      onClick={() => void requestGraphChange()}
                      style={pillBtn(false)}
                    >
                      {t("auto.flow.architect_ask")}
                    </button>
                  </div>
                  {proposal ? (
                    <div
                      data-testid="graph-patch-proposal"
                      style={{
                        padding: "12px 14px",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--accent-soft)",
                        background: "var(--paper)",
                        fontSize: 12,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{t("auto.flow.architect_preview")}</div>
                      {proposal.rationale ? (
                        <div style={{ color: "var(--ink-soft)" }}>{proposal.rationale}</div>
                      ) : null}
                      {proposal.summary.added.length > 0 ? (
                        <div>{t("auto.flow.architect_added")}: {proposal.summary.added.join(", ")}</div>
                      ) : null}
                      {proposal.summary.removed.length > 0 ? (
                        <div>{t("auto.flow.architect_removed")}: {proposal.summary.removed.join(", ")}</div>
                      ) : null}
                      {proposal.summary.changed.length > 0 ? (
                        <div>{t("auto.flow.architect_changed")}: {proposal.summary.changed.join(", ")}</div>
                      ) : null}
                      {proposal.risks.length > 0 ? (
                        <div style={{ color: "var(--ink)" }}>
                          {t("auto.flow.architect_check")}: {proposal.risks.map((risk) => t(`auto.flow.risk_${risk}` as never)).join(", ")}
                        </div>
                      ) : null}
                      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                        <button
                          className="titlebar-nodrag"
                          disabled={architectBusy}
                          onClick={() => void applyProposal()}
                          style={actionBtn}
                        >
                          {t("auto.flow.architect_apply")}
                        </button>
                        <button
                          className="titlebar-nodrag"
                          disabled={architectBusy}
                          onClick={() => setProposal(null)}
                          style={pillBtn(false)}
                        >
                          {t("auto.flow.architect_discard")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ★상세(인스펙터)는 오른쪽 열이다 — 오너 지시(2026-08-09):
            "탭은 로그·대화만 두고 상세는 기존처럼 오른쪽 사이드바를 써야지".
            캔버스를 보면서 결정해야 하는 것(승인·시작 값·노드 설정)은 캔버스 **옆**에,
            시간순으로 쌓이는 것(로그·대화)은 캔버스 **아래**에. */}
        {rightOpen ? (
          <aside className="automation-inspector-column titlebar-nodrag" data-testid="inspector-column">
            {inspectorContent}
          </aside>
        ) : (
          <button
            type="button"
            className="automation-inspector-reopen titlebar-nodrag"
            data-testid="inspector-reopen"
            onClick={() => setRightOpen(true)}
            title={locale === "en" ? "Show details" : "상세 열기"}
          >
            {decisionCount > 0 ? <em>{decisionCount}</em> : null}
            <span aria-hidden="true">⟨</span>
            <span className="automation-inspector-reopen-label">{locale === "en" ? "Details" : "상세"}</span>
          </button>
        )}


      </div>
    </div>
  );
}

/**
 * 되돌아가는 연결의 반복 상한을 정하는 자리.
 *
 * ★이게 없어서 생기던 일: 캔버스에서 반복(뒤로 가는 연결)을 그리면 저장은 되는데
 *   실행만 `LOOP_BOUND_UNDECLARED`로 거절됐고, 그 사유가 안내하는 "되돌아가는 연결을 눌러
 *   반복 횟수를 정하세요"는 존재하지 않는 화면을 가리켰다. 상한을 넣을 방법이 아예 없어서
 *   사람은 그 그래프를 영영 못 돌렸다.
 * 상한을 요구하는 이유는 따로 있다 — 자동화는 사람이 보지 않는 동안 돌기 때문에,
 *   멈출 지점이 없는 반복은 아무도 멈춰 줄 수 없다.
 */
function LoopBoundPanel({
  isBackEdge, value, onChange, onClose, onDelete, locale,
}: {
  isBackEdge: boolean;
  value: number | null;
  onChange: (v: number | null) => void;
  onClose: () => void;
  /** 편집 모드에서만 온다 — 보기 모드에서 선을 지우게 두지 않는다. */
  onDelete?: () => void;
  locale: "ko" | "en";
}) {
  const L = (ko: string, en: string) => (locale === "en" ? en : ko);
  return (
    <div className="automation-node-panel" data-one-content-slot>
      <div className="automation-node-panel-head">
        <strong>{isBackEdge ? "되돌아가는 연결" : "연결"}</strong>
        <button type="button" className="ghost-btn" onClick={onClose}>{L("닫기", "Close")}</button>
      </div>
      {isBackEdge ? (
        <>
          <p className="automation-node-panel-hint">
            앞 단계로 되돌아갑니다. 몇 바퀴까지 돌지 정해야 실행할 수 있어요 —
            자동화는 아무도 보고 있지 않을 때 돌기 때문입니다.
          </p>
          <label className="automation-field">
            <span>{L("최대 반복 횟수", "Maximum repeats")}</span>
            <input
              type="number" min={1} max={50}
              value={value ?? ""}
              placeholder={L("예: 3", "e.g. 3")}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange(Number.isFinite(n) && n >= 1 && n <= 50 ? Math.round(n) : null);
              }}
            />
          </label>
          <div className="automation-chip-row">
            {[2, 3, 5].map((n) => (
              <button key={n} type="button" className={value === n ? "chip chip-on" : "chip"} onClick={() => onChange(n)}>
                {n}번
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="automation-node-panel-hint">
          앞에서 뒤로 가는 보통 연결입니다. 따로 정할 것이 없어요.
        </p>
      )}
      {/* ★한 번 그린 선을 지울 방법이 없었다(오너 실측 2026-08-08) — 키보드(Delete)를
          모르는 사람도 지울 수 있게 버튼으로. */}
      {onDelete ? (
        <button type="button" className="automation-edge-delete" onClick={onDelete}>
          {L("이 연결 삭제", "Delete this connection")}
        </button>
      ) : null}
    </div>
  );
}

type TFn = ReturnType<typeof useT>["t"];

function NodeInspector({ node, onClose, t }: { node: WorkflowNode; onClose: () => void; t: TFn }) {
  const entries = Object.entries(node.config ?? {});
  return (
    <aside
      className="titlebar-nodrag automation-embedded-panel"
      style={{ background: "var(--paper)", overflowY: "auto", padding: 16 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: NODE_ACCENT[node.type] ?? "var(--muted-deep)",
            flex: 1,
          }}
        >
          {node.type}
        </span>
        {/* 피츠: 실측 18×18 이라 조준해야 눌렸다. 보이는 글리프는 그대로, 히트만 28×28. */}
        <button
          onClick={onClose}
          aria-label={t("common.close")}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 28, minHeight: 28, color: "var(--muted-deep)" }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginBottom: 16 }}>{node.label || node.type}</div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("auto.flow.no_config")}</div>
      ) : (
        <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  color: "var(--muted-deep)",
                  marginBottom: 4,
                }}
              >
                {key}
              </dt>
              <dd style={{ margin: 0 }}>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    fontFamily: typeof value === "string" ? "var(--font-body)" : "var(--font-mono)",
                    fontSize: 12,
                    background: "var(--paper-2)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-sm)",
                    padding: 8,
                    margin: 0,
                    color: "var(--ink)",
                  }}
                >
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </pre>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}

const noticeBox: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: 16,
  fontSize: 13,
  lineHeight: 1.5,
};

const actionBtn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: "var(--radius-md)",
  fontSize: 12.5,
  fontWeight: 600,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  boxShadow: "var(--neu-raised)",
  cursor: "pointer",
  // pillBtn과 같은 이유 — 이 자리가 "Turn on"을 두 줄로 접어 버튼 높이를 흔들었다.
  whiteSpace: "nowrap",
  flexShrink: 0,
};

/** 도는 중임을 몸으로 보여주는 라벨 — 글자만 바꾸면 아무도 못 알아본다(실측). */
function SpinnerLabel({ text }: { text: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="describe-spinner" aria-hidden />
      {text}
    </span>
  );
}

function pillBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid var(--paper-edge)",
    background: active ? "var(--fill-1)" : "var(--paper-2)",
    color: active ? "var(--accent)" : "var(--muted-deep)",
    cursor: "pointer",
    // 라벨은 한 줄로 — 폭이 모자라면 글자가 접혀 "Edit name & / schedule",
    // "Turn / on"처럼 두 줄이 되고 알약 높이가 제각각 튀었다(실측 2026-08-18).
    whiteSpace: "nowrap",
    // 버튼이 눌리는 대신 넘치게 둔다. 줄어들 수 있으면 제목 자리를 먼저 먹고,
    // 결국 제목이 세로 한 글자씩 무너진다.
    flexShrink: 0,
  };
}
