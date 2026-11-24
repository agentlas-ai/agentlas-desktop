"use client";
import { usageExhaustedSuffix } from "@/lib/usage-copy";
import type { ReactNode } from "react";
import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  IconBuilding,
  IconUsers,
  IconWand,
  IconFolder,
  IconPaperclip,
  IconShield,
  IconCheck,
  IconClose,
} from "@/components/Icon";
import { BuildLaunch, BuildResources } from "@/components/build/BuildLaunch";
import { BuildSavedWindow } from "@/components/build/BuildSavedWindow";
import { LiveBuildFiles, useLiveBuildKey } from "@/components/build/LiveBuildFiles";
import styles from "@/components/build/BuildWorkbench.module.css";
import connectionsStyles from "@/components/build/BuildConnectionsSettings.module.css";
import { IconArrowLeft } from "@/components/Icon";
import { grantForDroppedFile, grantForPastedAttachment, ipc } from "@/lib/ipc";
import { MediaStrip, mediaKindOf, type MediaStripItem } from "@/components/media/MediaStrip";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { announceAgentRosterChange } from "@/lib/agent-roster-events";
import { KeyStatusBanner } from "@/components/KeyStatusBanner";
import { ElapsedClock } from "@/components/ElapsedClock";
import { McpBuildInterviewCard } from "@/components/build/McpBuildInterviewCard";
import { McpAttachmentReceiptCard } from "@/components/build/McpAttachmentReceiptCard";
import { CloudSaveChoiceDialog } from "@/components/build/CloudSaveChoiceDialog";
import { OneSuggestionReviewHandoffBanner, type OneReviewSeedApplyResult } from "@/components/one/OneSuggestionReviewHandoff";
import type { DirListing, FsPathGrant, FsReadScope, HephaestusStatus, OneSuggestionReviewSeed, RuntimeSelection, RuntimeStatus, UsageSnapshot } from "@/lib/types";
import {
  subscribe as buildSubscribe,
  getSnapshot as getBuildSnapshot,
  setRequest as setBuildRequest,
  setMode as setBuildMode,
  setWorkspace as setBuildWorkspace,
  reauthorizeRestoredBuildWorkspace,
  setRuntime as setBuildRuntime,
  startBuild,
  prepareBuildHandoff,
  approveBuildMcpPlan,
  describeAllocationRuntime,
  resolveRuntimeEscalation,
  answerBuild,
  canContinueCompletedBuild,
  continueCompletedBuild,
  restoredCompletionNeedsReview,
  cancelBuild,
  resumeBuild,
  resetBuild,
  startFreshBuild as startFreshBuildStore,
  addAttachments,
  removeAttachment,
  updateBuildSecurityScan,
  presentBuildCloudSaveChoice,
  beginBuildCloudSave,
  finishBuildCloudSave,
  chooseBuildLocalOnly,
  type Mode,
  type BuildAttachment,
  type LogLine,
  reattachRunningBuild,
} from "@/lib/build-session";
import { buildScanDisposition, buildScanFindings, buildScanSeverityBucket } from "@/lib/build-scan";
import type { ChatQuestion } from "@/components/ChatStream";
import type { CloudAgentPublishProgressEvent, CloudAgentPublishStage } from "@shared/types";
import { selectionForRuntime } from "@shared/runtime-selection";
import { providerQuotaExhausted } from "@shared/runtime-quota";
import { Select } from "@/components/Select";
import { fileManagerName, shortcutLabel, useUiPlatform } from "@/lib/platform-copy";

type StageState = "pending" | "active" | "done" | "error";
const OPENCRAB_QUESTION_ID = "opencrab-ontology";

const MODES: { id: Mode; label: string; labelEn: string; desc: string; descEn: string; icon: typeof IconBuilding }[] = [
  { id: "single", label: "단일 에이전트", labelEn: "Single agent", desc: "혼자 일하는 에이전트 하나 — 기억·기술·스스로 개선", descEn: "A single agent that works on its own — memory, skills, self-improvement", icon: IconWand },
  { id: "team", label: "멀티 에이전트 팀", labelEn: "Multi-agent team", desc: "여러 역할이 함께 일하는 에이전트 팀 (기획·실행·검수)", descEn: "A team of agents that plan, run, and review together", icon: IconUsers },
  { id: "package", label: "기존 에이전트 패키징", labelEn: "Package existing agent", desc: "외부/로컬 에이전트를 Agentlas 아키텍처로 변환·복구", descEn: "Convert/repair an external or local agent into Agentlas", icon: IconBuilding },
];

// 사용자에게 보이는 실제 순서 — 요구사항을 먼저 확인한 뒤 엔진/연결을 준비하고,
// 그 다음에만 에이전트가 조사·생성·검증·전달을 수행한다. sub 는 그 단계가 지금 하는 일을 사람 말로 한 문장 —
// 지금 단계 줄에만, 엔진이 실제로 한 일이 아직 없을 때 쓴다.
const STAGES: { key: string; label: string; labelEn: string; sub: string; subEn: string }[] = [
  { key: "brief", label: "요구사항 확인", labelEn: "Confirm brief", sub: "무엇을 만들지 확인하고 있어요", subEn: "Confirming what the agent should do" },
  { key: "setup", label: "엔진·연결 준비", labelEn: "Set up engine", sub: "사용할 모델과 연결을 준비하고 있어요", subEn: "Preparing the model and connections" },
  { key: "research", label: "리서치·설계", labelEn: "Research & plan", sub: "조사하고 구조를 설계하고 있어요", subEn: "Researching and planning the package" },
  { key: "generate", label: "패키지 생성", labelEn: "Generate package", sub: "설치할 수 있는 파일을 만들고 있어요", subEn: "Writing the installable files" },
  { key: "verify", label: "검증", labelEn: "Verify", sub: "보안과 구성을 점검하고 있어요", subEn: "Checking security and integrity" },
  { key: "deliver", label: "전달", labelEn: "Deliver", sub: "내 라이브러리에 설치할 준비를 하고 있어요", subEn: "Getting it ready to install" },
];

function engineLabel(r: RuntimeStatus, ko: boolean): string {
  switch (r.kind) {
    case "claude-code":
      return "Claude";
    case "codex":
      return "Codex (GPT)";
    case "antigravity":
      return "Antigravity";
    case "agentlas":
      return "Agentlas";
    case "ollama":
      return ko ? "Ollama · 로컬" : "Ollama · local";
    case "agentlas-local":
      return "Agentlas Local · On-device";
    default:
      return r.kind;
  }
}

function runtimeKey(sel: Pick<RuntimeSelection, "kind" | "source"> | null): string {
  return sel ? `${sel.kind}:${sel.source ?? ""}` : "";
}

const BUILD_BLOCKING_USAGE_ERRORS = new Set(["auth_expired", "credentials_corrupt", "keychain_blocked", "quota_exhausted"]);

function runtimeUsageProvider(runtime: RuntimeStatus, usage: UsageSnapshot | null) {
  if (!usage) return null;
  // These adapters observe the CLI account, never a same-backend API key or ACP source.
  switch (runtime.kind) {
    case "claude-code":
    case "codex":
    case "kimi":
    case "grok":
      return usage.providers.find((provider) => provider.provider === runtime.kind) ?? null;
    default:
      return null;
  }
}

function runtimeUsageBlocked(runtime: RuntimeStatus, usage: UsageSnapshot | null, model: string | null | undefined = runtime.model): boolean {
  const provider = runtimeUsageProvider(runtime, usage);
  if (!provider) return false;
  if (provider.status === "error" && provider.error && BUILD_BLOCKING_USAGE_ERRORS.has(provider.error)) return true;
  return provider.status === "ok" && providerQuotaExhausted(provider, Date.now(), model ?? undefined, provider.provider);
}

function fmtLogTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Rows drawn in the activity box; the earlier ones are counted, not drawn. */
const BUILD_LOG_VISIBLE_ROWS = 400;

/**
 * The log rows re-render only when the log itself changes. The liveness row beside them is replaced every 2 s, and
 * without this boundary each tick re-rendered every row of a long build (review 2026-10-16 clients-13 / H5).
 */
const BuildLogRows = memo(function BuildLogRows({ log, ko }: { log: readonly LogLine[]; ko: boolean }) {
  const hidden = Math.max(0, log.length - BUILD_LOG_VISIBLE_ROWS);
  return (
    <>
      {hidden > 0 && (
        <div data-kind="log" className="build-log-omitted">
          {ko ? `이전 기록 ${hidden}줄은 생략했습니다.` : `${hidden} earlier lines not shown.`}
        </div>
      )}
      {log.slice(hidden).map((l, i) => (
        <div key={hidden + i} data-kind={l.kind}>
          <span className="build-log-time">{fmtLogTime(l.at)}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </>
  );
});

function cloudUploadStageLabel(stage: CloudAgentPublishStage, detail: string, ko: boolean): string {
  const labels: Record<CloudAgentPublishStage, [string, string]> = {
    starting: ["Cloud 저장 준비 중", "Preparing Cloud save"],
    cleaning: ["패키지 정리 중", "Cleaning the package"],
    "routing-card": ["에이전트 역할 정보 확인 중", "Checking agent role metadata"],
    remediating: ["안전하게 자동 수정 중", "Applying safe fixes"],
    blockers: ["차단 항목 확인 중", "Checking blockers"],
    excluded: ["제외 파일 확인 중", "Checking excluded files"],
    "scan-clean": ["보안 점검 통과", "Security scan passed"],
    scanning: ["보안 점검 중", "Running security checks"],
    metadata: ["에이전트 정보 정리 중", "Preparing agent metadata"],
    packaging: ["업로드 패키지 생성 중", "Building the upload package"],
    reviewing: ["비공개 저장 조건 확인 중", "Reviewing private-save requirements"],
    uploading: ["Agent Cloud에 업로드 중", "Uploading to Agent Cloud"],
    receipt: ["저장 결과 확인 중", "Verifying the save receipt"],
    done: ["Agent Cloud 저장 완료", "Saved to Agent Cloud"],
    error: ["Cloud 저장에 문제가 생겼습니다", "Cloud save needs attention"],
  };
  const label = labels[stage][ko ? 0 : 1];
  const safeDetail = detail.trim().replace(/\s+/g, " ").slice(0, 120);
  return safeDetail ? `${label} · ${safeDetail}` : label;
}

function friendlyHephaestusMessage(raw: string, ko: boolean): string {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (!text) return ko ? "알 수 없음" : "Unknown error";
  if (lower.includes("routing_card_required")) {
    return ko
      ? "라우팅 카드가 없어 업로드가 멈췄습니다. 패키지의 routing-card.json 또는 agentlas.json 라우팅 정보를 먼저 보강하세요."
      : "Upload stopped because the routing card is missing. Add routing-card.json or routing metadata in agentlas.json.";
  }
  if (lower.includes("unsafe_path")) {
    return ko
      ? "안전하지 않은 파일 경로가 있어 멈췄습니다. 절대경로, .., 심볼릭 링크가 패키지 밖을 가리키는지 확인하세요."
      : "Upload stopped because a file path is unsafe. Check absolute paths, .. segments, or symlinks escaping the package.";
  }
  if (lower.includes("manifest_missing") || lower.includes("agentlas.json")) {
    return ko
      ? "agentlas.json이 없거나 읽을 수 없습니다. 패키지 폴더에서 wizard/복구를 먼저 실행하세요."
      : "agentlas.json is missing or unreadable. Run the package wizard/repair step in the agent folder first.";
  }
  if (lower.includes("needs-review") || lower.includes("acknowledge")) {
    return ko
      ? "검토가 필요한 경고가 있습니다. 경고 내용을 확인한 뒤 다시 업로드하세요."
      : "The package has warnings that need review. Check the warnings before uploading again.";
  }
  if (lower.includes("quota")) {
    return ko
      ? "Agent Cloud 저장 한도 때문에 업로드가 멈췄습니다. 요금제의 저장 가능 에이전트 수를 확인하세요."
      : "Upload stopped because the Agent Cloud storage limit was reached. Check your plan's agent capacity.";
  }
  if (lower.includes("credit")) {
    return ko
      ? "에이전트 업로드는 무료입니다. 이전 서버 응답이 표시되었습니다. 새로고침한 뒤 다시 시도하세요."
      : "Agent uploads are free. Refresh and retry after this outdated server response.";
  }
  if (lower.includes("unauthorized") || lower.includes("not logged") || lower.includes("sign in") || /\b401\b/.test(lower)) {
    return ko
      ? "Agentlas 로그인이 필요합니다. 로그인한 뒤 같은 Cloud 선택으로 다시 시도하세요."
      : "Sign in to Agentlas, then retry the same Cloud choice.";
  }
  if (lower.includes("offline") || lower.includes("network") || lower.includes("enotfound") || lower.includes("fetch failed")) {
    return ko
      ? "네트워크에 연결한 뒤 다시 시도하세요. 로컬 패키지는 그대로 유지됩니다."
      : "Connect to the network and retry. The local package is unchanged.";
  }
  if (lower.includes("conflict") || lower.includes("compare-and-swap") || lower.includes("cas_") || /\b409\b/.test(lower)) {
    return ko
      ? "Cloud 버전이 다른 기기에서 변경됐습니다. 최신 상태를 확인한 뒤 다시 시도하세요."
      : "The Cloud version changed on another device. Refresh it before retrying.";
  }
  if (lower.includes("security") || lower.includes("secret") || lower.includes("blocked")) {
    return ko
      ? "보안 점검이 업로드를 막았습니다. 패키지를 수정하고 다시 검증하세요."
      : "The security check blocked upload. Fix and verify the package before retrying.";
  }
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

// UI-owned start lock survives client route changes. The legacy store has no
// cancellable preflight state, so do not invent Stop before it exposes a phase.
let uiStartOwner: object | null = null;
let uiStartRevision = 0;
const uiStartListeners = new Set<() => void>();
function subscribeUiStart(listener: () => void) {
  uiStartListeners.add(listener);
  return () => { uiStartListeners.delete(listener); };
}
function getUiStartPending() { return uiStartOwner !== null; }
function startFreshBuild() {
  if (getUiStartPending()) return false;
  const started = startFreshBuildStore();
  if (started) uiStartRevision += 1;
  return started;
}
function canEditBuildDraft(revision = uiStartRevision) {
  return !getUiStartPending() && revision === uiStartRevision
    && !["running", "interview", "mcp-review", "runtime-approval"].includes(getBuildSnapshot().phase);
}
async function startBuildWithUiLock(runtime?: RuntimeSelection) {
  if (uiStartOwner) return;
  const owner = {};
  uiStartOwner = owner;
  uiStartRevision += 1;
  uiStartListeners.forEach(listener => listener());
  try { await startBuild(runtime); }
  finally {
    if (uiStartOwner === owner) {
      uiStartOwner = null;
      uiStartListeners.forEach(listener => listener());
    }
  }
}

export default function BuildPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const uiOs = useUiPlatform();
  const startPending = useSyncExternalStore(subscribeUiStart, getUiStartPending, getUiStartPending);
  const [reattaching, setReattaching] = useState(() => getBuildSnapshot().phase === "idle" && !getBuildSnapshot().request);
  const [reattachProblem, setReattachProblem] = useState(false);
  const [screen, setScreen] = useState<"home" | "intro" | "editor">(() => getBuildSnapshot().phase === "idle" && !getBuildSnapshot().request ? "home" : "editor");
  // F-D10: a saved build (opened from the Builds tab) or an agent's Edit (?edit=<agentId>, ?build=<buildKey>) in the Build window.
  const [saved, setSaved] = useState<{ buildKey?: string; agentId?: string; name?: string } | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const edit = query.get("edit"), build = query.get("build");
    if (edit) setSaved({ agentId: edit, name: query.get("name") ?? undefined });
    else if (build) setSaved({ buildKey: build });
  }, []);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const connectionsBack = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (connectionsOpen) connectionsBack.current?.focus(); }, [connectionsOpen]);
  const [connectionsTarget, setConnectionsTarget] = useState<HTMLDivElement | null>(null);
  const [connectionsCloseRequest, setConnectionsCloseRequest] = useState(0);
  const [filesView, setFilesView] = useState(true);
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [publicSourceConsent, setPublicSourceConsent] = useState(false);
  const [folderMsg, setFolderMsg] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({});
  const [cloudChoiceError, setCloudChoiceError] = useState<string | null>(null);
  const [cloudUploadProgress, setCloudUploadProgress] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const cloudUploadInFlightRef = useRef<string | null>(null);
  const cloudUploadProgressIdRef = useRef<string | null>(null);

  // 모듈 레벨 빌드 스토어 구독 — 다른 메뉴로 이동했다 돌아와도 진행 상태(로그·단계·결과·인터뷰)가 유지된다.
  const s = useSyncExternalStore(buildSubscribe, getBuildSnapshot, getBuildSnapshot);
  useEffect(() => ipc()?.hephaestus.onBuilderOwnerChanged?.(() => {
    setReply("");
    setFollowUp("");
    setSelectedOptions({});
    setQuestionNotes({});
  }), []);

  // 앱을 다시 켜거나 새로고침해도 Main에서 돌고 있는 빌드에 다시 붙는다.
  // (메뉴 이동은 모듈 스토어가 이미 지키므로 여기 대상이 아니다.)
  useEffect(() => {
    const known = getBuildSnapshot();
    if (known.phase !== "idle" || known.request || known.runId) { setReattaching(false); return; }
    let alive = true;
    void (async () => {
      try {
        const restored = await reattachRunningBuild();
        if (!alive) return;
        // Legacy reattach treats IPC errors as null. A false return alone does
        // not establish that Main has no build; confirm it before opening input.
        if (!restored) {
          const check = ipc()?.hephaestus?.activeBuild;
          if (!check) throw new Error("build status unavailable");
          const active = await check();
          if (!alive) return;
          const age = active ? Date.now() - Date.parse(active.startedAt || "") : Number.POSITIVE_INFINITY;
          if (active && (active.running || (Number.isFinite(age) && age < 2 * 60_000))) {
            const reconnected = await reattachRunningBuild();
            if (!alive) return;
            const current = getBuildSnapshot();
            if (!reconnected && current.phase === "idle" && !current.request && !current.runId) throw new Error("build status unconfirmed");
          }
        }
        if (!alive) return;
        setReattaching(false);
        if (getBuildSnapshot().phase !== "idle") setScreen("editor");
      } catch { if (alive) setReattachProblem(true); }
    })();
    return () => { alive = false; };
  }, []);
  const { request, mode, workspace, workspaceGrant, runtime, phase, log, reached, errored, recoverable, error: buildError, result, registered, registeredEntity, pendingQuestions, pendingAllocation, awaitingReply, turn, attachments, mcpPlan, mcpReceipt, cloudSaveChoice, liveness, runId } = s;
  // Source disclosure belongs to one completed Build, not the next package.
  useEffect(() => { setPublicSourceConsent(false); }, [result]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const requestInputRef = useRef<HTMLTextAreaElement | null>(null);

  const applyOneReviewSeed = useCallback((seed: OneSuggestionReviewSeed): OneReviewSeedApplyResult => {
    if (seed.kind !== "agent_build" || seed.targetSurface !== "build" || seed.buildMode !== "single") return "blocked";
    if (reattaching || startPending || status === null) return "defer";
    if (!status.available) return "blocked";
    const current = getBuildSnapshot();
    if (
      current.phase !== "idle"
      || current.request !== ""
      || current.mode !== ""
      || current.attachments.length !== 0
      || current.log.length !== 0
      || current.runId !== null
      || current.result !== null
      || current.pendingQuestions.length !== 0
      || current.pendingAllocation !== null
      || current.mcpPlan !== null
      || current.mcpReceipt !== null
      || current.cloudSaveChoice !== null
    ) return "blocked";
    setBuildMode("single");
    setBuildRequest(ko
      ? "반복해서 완료한 작업 패턴을 맡을 단일 에이전트 하나를 새로 설계해줘. 역할·입력·출력·권한 경계를 먼저 인터뷰하고, 기존 에이전트의 시스템 프롬프트·파일·메모리·로컬 경로·자격 증명은 복사하지 마."
      : "Design one new single agent for the repeated completed-work pattern. Interview me first about its role, inputs, outputs, and permission boundaries; do not copy any existing system prompt, files, memory, local paths, or credentials.");
    setScreen("editor");
    return "applied";
  }, [ko, status, reattaching, startPending]);

  // 드롭/파일 인풋/붙여넣기 → 실제 디스크 경로(webUtils), 경로가 없으면(브라우저·붙여넣기) Main이 바이트를 고정한 파일 → 스토어 첨부.
  // 사진·영상·파일·폴더 모두, 개수·크기 제한 없이. 끝내 못 넣은 것은 이름과 함께 알린다(조용히 빼지 않는다).
  const addDroppedFiles = async (files: FileList | File[]) => {
    if (!canEditBuildDraft()) return;
    const revision = uiStartRevision;
    const items: BuildAttachment[] = [];
    const previews: Array<[string, string]> = [];
    const skipped: string[] = [];
    for (const f of Array.from(files)) {
      const grant = await grantForDroppedFile(f) ?? await grantForPastedAttachment(f);
      if (!canEditBuildDraft(revision)) return;
      if (!grant) { skipped.push(f.name || (ko ? "이름 없는 파일" : "unnamed file")); continue; }
      const p = grant.path;
      items.push({ path: p, grant, name: f.name || p.split(/[\\/]/).pop() || p, kind: grant.kind === "directory" ? "dir" : "file" });
      if (grant.kind !== "directory" && (f.type.startsWith("image/") || f.type.startsWith("video/"))) previews.push([p, URL.createObjectURL(f)]);
    }
    if (items.length > 0) addAttachments(items);
    if (previews.length > 0) setAttachmentPreviews((current) => new Map([...current, ...previews]));
    setAttachmentSkipped(skipped);
  };
  const [attachmentPreviews, setAttachmentPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [attachmentSkipped, setAttachmentSkipped] = useState<string[]>([]);

  const attachFolder = async () => {
    if (!canEditBuildDraft()) return;
    const revision = uiStartRevision;
    const dir = await ipc()?.fs.pickDirectory();
    if (!canEditBuildDraft(revision)) return;
    if (dir) addAttachments([{ path: dir.path, grant: dir, name: dir.path.split(/[\\/]/).pop() || dir.path, kind: "dir" }]);
  };
  const pendingQuestionKey = pendingQuestions.map((q) => q.id).join("|");
  const selectedCount = pendingQuestions.reduce((sum, q) => sum + (selectedOptions[q.id]?.length ?? 0), 0);
  const composedReply = useMemo(
    () => composeInterviewReply(pendingQuestions, selectedOptions, questionNotes, reply, ko),
    [pendingQuestions, reply, selectedOptions, questionNotes, ko],
  );

  const toggleInterviewOption = (questionId: string, label: string) => {
    setSelectedOptions((prev) => {
      const current = prev[questionId] ?? [];
      const question = pendingQuestions.find((item) => item.id === questionId);
      const next = question?.multiSelect
        ? current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label]
        : current.includes(label)
          ? []
          : [label];
      return { ...prev, [questionId]: next };
    });
  };

  const setQuestionNote = (questionId: string, value: string) => {
    setQuestionNotes((prev) => ({ ...prev, [questionId]: value }));
  };

  const confirmInterviewReply = () => {
    if (!composedReply.trim()) return;
    const openCrabQuestion = pendingQuestions.find((q) => q.id === OPENCRAB_QUESTION_ID);
    const openCrabSelection = selectedOptions[OPENCRAB_QUESTION_ID]?.[0];
    // No answer is a privacy-safe skip. Only the first, main-authored option
    // grants this build permission to send its request to OpenCrab.
    const openCrabChoice = openCrabQuestion
      ? openCrabSelection === openCrabQuestion.options[0]?.label
        ? "use"
        : "skip"
      : undefined;
    setSelectedOptions({});
    setQuestionNotes({});
    const text = composedReply.trim();
    if (!text) return;
    setReply("");
    void answerBuild(text, openCrabChoice);
  };

  useEffect(() => {
    ipc()?.hephaestus.status(locale).then(setStatus).catch(() => setStatus(null));
    ipc()?.runtime.detect().then(setRuntimes).catch(() => setRuntimes([]));
    ipc()?.usage.snapshot().then((snapshot) => setUsage(snapshot ?? null)).catch(() => setUsage(null));
  }, [locale]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // The live tail row sits below the last log line, so a heartbeat that does
    // not touch `log` would otherwise render off the bottom of the box.
  }, [log, liveness]);
  useEffect(() => {
    setSelectedOptions({});
    setQuestionNotes({});
    setReply("");
  }, [pendingQuestionKey]);
  useEffect(() => {
    setCloudChoiceError(null);
    setCloudUploadProgress(null);
    cloudUploadProgressIdRef.current = null;
  }, [cloudSaveChoice?.id]);
  useEffect(() => {
    const off = ipc()?.cloudAgents.onProgress((event: CloudAgentPublishProgressEvent) => {
      if (!cloudUploadProgressIdRef.current || event.progressId !== cloudUploadProgressIdRef.current) return;
      setCloudUploadProgress(cloudUploadStageLabel(event.stage, event.detail ?? "", ko));
    });
    // A renderer can briefly outlive an older/missing preload bridge during an
    // update. Cleanup must never call a promise/null placeholder as a function
    // and crash the destination screen while navigating away from Build.
    return () => {
      if (typeof off === "function") off();
    };
  }, [ko]);
  useEffect(() => {
    if (cloudSaveChoice?.status === "pending") {
      presentBuildCloudSaveChoice(cloudSaveChoice.id);
    }
  }, [cloudSaveChoice?.id, cloudSaveChoice?.status]);

  // 단계 상태 배열 도출.
  const stageStates: StageState[] = useMemo(() => {
    return STAGES.map((_, i) => {
      if (errored && i === Math.min(reached, STAGES.length - 1)) return "error";
      if (i < reached) return "done";
      if (i === reached && ["running", "interview", "mcp-review", "runtime-approval"].includes(phase)) return "active";
      if (phase === "done") return "done";
      return "pending";
    });
  }, [reached, phase, errored]);

  // 실행 경과 표시 — 텍스트 한 줄 없이도 "죽지 않았다"를 증명하는 유일한 신호.
  // 단계(reached)가 바뀔 때만 리셋한다: 같은 단계 안에서 여러 인터뷰 턴이 오가도
  // (phase가 running↔interview로 왕복해도) 그 단계에 들어간 뒤 누적 시간을 보여준다.
  // 시계 자체는 ElapsedClock 리프가 돌므로 이 페이지는 초당 리렌더되지 않는다.
  const [stageStartedAt, setStageStartedAt] = useState<number>(() => Date.now());
  useEffect(() => {
    setStageStartedAt(Date.now());
  }, [reached]);
  // The start time is seeded at MOUNT, but a build usually starts long after the
  // page was opened — without this the very first stage claimed however many
  // minutes the page had been sitting idle. A liveness element that overstates
  // the clock is worse than none, so re-seed when the build becomes active.
  const wasActiveRef = useRef(false);
  useEffect(() => {
    const active = phase === "running" || phase === "interview" || phase === "mcp-review" || phase === "runtime-approval";
    if (active && !wasActiveRef.current) setStageStartedAt(Date.now());
    wasActiveRef.current = active;
  }, [phase]);

  const pickWorkspace = async () => {
    if (!canEditBuildDraft()) return;
    const revision = uiStartRevision;
    const api = ipc();
    if (!api) {
      setFolderMsg(ko ? "폴더 선택을 사용할 수 없습니다." : "Folder picker is not available.");
      return;
    }
    setFolderMsg(ko ? "폴더 선택 창을 여는 중..." : "Opening folder picker...");
    try {
      const dir = await api.fs.pickDirectory();
      if (!canEditBuildDraft(revision)) return;
      if (dir) {
        setBuildWorkspace(dir);
        setFolderMsg(ko ? "생성 폴더가 선택되었습니다." : "Output folder selected.");
      } else {
        setFolderMsg(ko ? "폴더 선택이 취소되었습니다." : "Folder selection cancelled.");
      }
    } catch (err) {
      setFolderMsg((ko ? "폴더 선택 실패: " : "Folder picker failed: ") + friendlyHephaestusMessage(String(err), ko));
    }
  };

  const reauthorizeWorkspace = async () => {
    if (!canEditBuildDraft()) return;
    const revision = uiStartRevision;
    const api = ipc();
    if (!api) return;
    setFolderMsg(ko ? "생성 폴더 권한을 다시 요청하는 중..." : "Requesting output-folder access again...");
    try {
      const dir = await api.fs.pickDirectory();
      if (!canEditBuildDraft(revision)) return;
      if (!dir) {
        setFolderMsg(ko ? "폴더 다시 선택을 취소했습니다." : "Folder re-selection was cancelled.");
        return;
      }
      setBuildWorkspace(dir);
      resetBuild();
      setFolderMsg(ko ? "폴더 권한을 갱신했습니다. 요청과 설정은 유지됐습니다. 다시 시작을 눌러 확인하세요." : "Folder access was refreshed. Your request and settings were kept. Start again when ready.");
    } catch {
      setFolderMsg(ko ? `폴더 권한을 갱신하지 못했습니다. ${fileManagerName(true, uiOs)}에서 폴더가 실제로 있는지 확인하세요.` : `Could not refresh folder access. Check that the folder still exists in ${fileManagerName(false, uiOs)}.`);
    }
  };

  const reauthorizeConversationWorkspace = async () => {
    try {
      const dir = await ipc()?.fs.pickDirectory();
      if (!dir || !reauthorizeRestoredBuildWorkspace(dir)) {
        setFolderMsg(ko ? "이전 작업 폴더를 선택해 주세요." : "Select the previous workspace.");
      } else {
        setFolderMsg(ko ? "작업 폴더 권한을 다시 확인했습니다." : "Workspace access was renewed.");
      }
    } catch {
      setFolderMsg(ko ? "작업 폴더 권한을 확인하지 못했습니다." : "Could not renew workspace access.");
    }
  };

  // 빌드 화면은 런타임만 고르게 하고 모델은 못 고르게 돼 있었다 — Claude 안에서
  // opus/sonnet 을 나눌 방법이 없어 "opus 왜 없어"가 나왔다. One 컴포저는 이미
  // `runtime.listModels` 로 모델까지 고르므로, 같은 배선을 여기에도 쓴다.
  const [modelsByRuntime, setModelsByRuntime] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  useEffect(() => {
    const api = ipc();
    if (!api || runtimes.length === 0) return;
    let cancelled = false;
    void Promise.all(runtimes.map(async (r) => {
      const models = await api.runtime.listModels({
        kind: r.kind, backend: r.backend, availableModels: r.availableModels,
      }).catch(() => []);
      return [`${r.kind}:${r.source}`, models.map((m) => ({ id: m.id, label: m.label }))] as const;
    })).then((pairs) => { if (!cancelled) setModelsByRuntime(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [runtimes]);

  const onSelectRuntime = (key: string) => {
    if (!canEditBuildDraft()) return;
    if (!key) {
      setBuildRuntime(null);
      return;
    }
    // key 형식: "<kind>:<source>" 또는 "<kind>:<source>::<modelId>"
    const [runtimeKeyPart, modelId] = key.split("::");
    const r = runtimes.find((x) => `${x.kind}:${x.source}` === runtimeKeyPart);
    setBuildRuntime(r
      ? selectionForRuntime(r, { model: modelId || r.model || null, effort: null, longContext: undefined })
      : null);
  };

  const installToLibrary = async () => {
    if (registeredEntity?.id) {
      navigate(`/library/agents?agentId=${encodeURIComponent(registeredEntity.id)}`);
      return;
    }
    const target = result?.workspace ?? workspace;
    const scope = result?.readScope ?? workspaceGrant?.scope;
    if (!target || !scope) return;
    try {
      const imported = await ipc()?.team.importLocalFolder({ path: target, scope });
      if (imported?.id) {
        announceAgentRosterChange({ action: "upserted", agent: imported, source: "build" });
        navigate(`/library/agents?agentId=${encodeURIComponent(imported.id)}`);
      }
    } catch (e) {
      setActionMsg((ko ? "설치 실패: " : "Install failed: ") + friendlyHephaestusMessage((e as Error).message, ko));
    }
  };

  const uploadToPublicHub = async () => {
    const target = result?.workspace ?? workspace;
    const scope = result?.readScope ?? workspaceGrant?.scope;
    if (!target || !scope) return;
    setActionMsg(ko ? "공개 Hub에 제출 중…" : "Submitting to the public Hub…");
    try {
      const res = await ipc()?.hephaestus.publish({ folder: target, scope, visibility: "marketplace", publicSourceConsent });
      const raw = res?.error ?? res?.stderr ?? "";
      setActionMsg(
        res?.ok
          ? (ko ? "Hub 공개 제출 완료. Hub에서 실제 공개·호출 상태를 확인하세요." : "Submitted to the public Hub. Verify its live publish and call status in Hub.")
          : (ko ? "업로드 실패. 파일은 그대로입니다: " : "Upload failed. Files were not changed: ") + friendlyHephaestusMessage(raw, ko),
      );
    } catch (err) {
      setActionMsg((ko ? "업로드를 시작하지 못했습니다. 파일은 그대로입니다: " : "Upload could not start. Files were not changed: ") + friendlyHephaestusMessage(String(err), ko));
    }
  };

  const saveBuildChoiceToCloud = async () => {
    const choice = cloudSaveChoice;
    if (!choice || choice.status === "uploading" || cloudUploadInFlightRef.current === choice.id) return;
    const claimed = beginBuildCloudSave(choice.id);
    if (!claimed) {
      setCloudChoiceError(
        ko
          ? "이 선택은 더 이상 현재 빌드와 일치하지 않습니다. 현재 결과에서 다시 선택하세요."
          : "This choice no longer matches the current Build. Choose again from the current result.",
      );
      return;
    }
    cloudUploadInFlightRef.current = choice.id;
    const progressId = window.crypto.randomUUID();
    cloudUploadProgressIdRef.current = progressId;
    setCloudUploadProgress(ko ? "Cloud 저장 준비 중" : "Preparing Cloud save");
    setCloudChoiceError(null);
    try {
      const api = ipc();
      if (!api) throw new Error("Desktop bridge unavailable");
      // The renderer consent is frozen to this Build generation. Main resolves
      // the exact folder against its capability again and pins the operation to
      // owner-private/static-only without a second native confirmation.
      const res = await api.cloudAgents.saveBuiltPrivate({
        folder: claimed.folder,
        scope: claimed.scope,
        progressId,
      });
      if (res.status !== "registered" || !res.registration) {
        throw new Error(res.summary || res.review?.summary || "Cloud save failed");
      }
      if (finishBuildCloudSave(choice.id, true)) {
        setActionMsg(
          res.registration.localSyncStored === false
            ? ko
              ? "Agent Cloud에는 저장됐지만, 이 데스크탑에 동기화 기록을 남기지 못했어요. 수정하기 전에 Cloud 최신본을 복원해 주세요."
              : "Saved to Agent Cloud, but this computer could not store the sync receipt. Restore the latest Cloud copy before editing."
            : ko
              ? "내 Agent Cloud에 비공개 저장했습니다."
              : "Saved privately to your Agent Cloud.",
        );
      }
    } catch (error) {
      setCloudUploadProgress(null);
      if (finishBuildCloudSave(choice.id, false)) {
        setCloudChoiceError(
          (ko
            ? "Cloud에 올리지 못했습니다. 로컬 패키지와 조직도 등록은 그대로 유지됩니다. "
            : "Could not upload to Cloud. The local package and org-chart registration are unchanged. ")
            + friendlyHephaestusMessage(error instanceof Error ? error.message : String(error), ko),
        );
      }
    } finally {
      if (cloudUploadInFlightRef.current === choice.id) cloudUploadInFlightRef.current = null;
      if (cloudUploadProgressIdRef.current === progressId) cloudUploadProgressIdRef.current = null;
    }
  };

  const keepBuildLocalOnly = () => {
    const choice = cloudSaveChoice;
    if (!choice || !chooseBuildLocalOnly(choice.id)) return;
    setCloudChoiceError(null);
    setActionMsg(ko ? "이 데스크탑에만 저장했어요. 네트워크 요청은 보내지 않았어요." : "Kept on this computer only. No network request was sent.");
  };

  const engineMissing = status ? !status.available : false;
  const selectedRuntimeStatus = runtime
    ? runtimes.find((item) => runtimeKey(item) === runtimeKey(runtime)) ?? null
    : runtimes.find((item) => item.active) ?? runtimes[0] ?? null;
  const selectedRuntimeUsageProvider = selectedRuntimeStatus ? runtimeUsageProvider(selectedRuntimeStatus, usage) : null;
  const selectedRuntimeBannerRuntime = selectedRuntimeUsageProvider ? selectedRuntimeStatus : null;
  const selectedRuntimeProviderLabel = selectedRuntimeStatus
    ? selectedRuntimeUsageProvider?.label ?? engineLabel(selectedRuntimeStatus, ko)
    : null;
  const selectedRuntimeBlocked = selectedRuntimeStatus ? runtimeUsageBlocked(selectedRuntimeStatus, usage, runtime?.model ?? selectedRuntimeStatus.model) : false;
  const running = phase === "running";
  // 대화형 빌드가 진행 중(엔진 실행 중이거나 인터뷰 답변 대기 중)이면 컴포저 입력을 잠근다.
  const busy = phase === "running" || phase === "mcp-review" || phase === "runtime-approval" || phase === "interview";
  const editingLocked = busy || startPending;
  const startBlocker = !request.trim()
    ? (ko ? "요청을 먼저 입력하세요." : "Enter a request first.")
    : !workspace
      ? (ko ? "생성 폴더를 선택하세요." : "Choose an output folder.")
      : engineMissing
        ? (ko ? "제작 엔진을 사용할 수 없습니다." : "The build engine is unavailable.")
        : selectedRuntimeBlocked
          ? (ko ? "선택된 AI 엔진의 사용량이 소진됐습니다. 위에서 사용 가능한 다른 엔진을 선택하세요." : "The selected AI engine has no usage remaining. Choose another available engine above.")
        : null;
  const openBuildDraft = (text: string) => {
    if (getUiStartPending()) { setScreen("editor"); return; }
    // A template is a NEW build, never permission to overwrite an active one.
    if (screen === "home" || getBuildSnapshot().phase !== "idle") {
      if (!startFreshBuild()) { setScreen("editor"); return; }
    }
    uiStartRevision += 1;
    setBuildRequest(text);
    setScreen("editor");
  };
  // F-D10: the saved Edit window hands its request to THIS screen's store (session, approvals, runtime stay here): same folder, mode "package", request filled in;
  // the person then starts the build with the usual button. A build that is running, interviewing or waiting for an approval is never overwritten.
  const continueEdit = (input: { request: string; workspaceGrant: unknown }): string => {
    const grant = input.workspaceGrant as FsPathGrant | null;
    if (!grant || typeof grant.path !== "string" || !grant.scope) return "workspace_missing";
    if (getUiStartPending()) return "running";
    const handed = prepareBuildHandoff({ workspace: grant, request: input.request, mode: "package" });
    if (!handed.ok) return handed.phase;
    uiStartRevision += 1;
    setSaved(null);
    setScreen("editor");
    return "started";
  };
  // F-D10: while a build runs (and after it ends) its files are shown in two columns beside the conversation, as in the picture; the settings column returns for the
  // other phases (interview, MCP plan, model choice) and with the "Files" button off.
  const liveKey = useLiveBuildKey(phase, runId);
  const showLiveFiles = filesView && Boolean(liveKey.key) && (phase === "running" || phase === "done");
  const resultScanDisposition = result ? buildScanDisposition(result.securityScan) : "unverified";
  const resultHasSecurityAdvisory = resultScanDisposition !== "passed";

  const draft = phase === "idle";
  // 엔진이 없을 때 같은 사실을 단추 옆 글과 경고 두 곳에서 말하지 않는다 — 경고가 그 자리에 있다.
  const startBlockerIsEngine = engineMissing && Boolean(request.trim()) && Boolean(workspace);
  const waiting = phase === "interview" || phase === "mcp-review" || phase === "runtime-approval";
  const folderLabel = workspace ? workspace.split(/[\\/]/).slice(-2).join("/") : "";
  const kindMeta = MODES.find((m) => m.id === mode) ?? null;
  const runtimeSummary = (() => {
    if (!runtime) return ko ? "자동 선택" : "Auto";
    const known = runtimes.find((item) => runtimeKey(item) === runtimeKey(runtime));
    const base = known ? engineLabel(known, ko) : String(runtime.kind);
    const model = runtime.model ? (modelsByRuntime[runtimeKey(runtime)]?.find((m) => m.id === runtime.model)?.label ?? runtime.model) : "";
    return model ? `${base} · ${model}` : base;
  })();
  const startNow = () => {
    const active = runtimes.find((item) => item.active) ?? runtimes[0];
    void startBuildWithUiLock(active ? selectionForRuntime(active, { longContext: active.longContextEnabled ?? undefined }) : undefined);
  };
  const progressLabel = phase === "idle"
    ? (ko ? "제작 단계 · 시작하면 진행이 여기에 보여요" : "Build steps · progress shows here once you start")
    : (ko ? "제작 진행" : "Build progress");
  // 진행은 이 목록 한 곳에서만 말한다. 지금 단계 줄에만 한 문장(엔진이 실제로 한 일, 없으면 그 단계가 하는 일)을 붙인다.
  const activeStageIndex = Math.min(reached, STAGES.length - 1);
  const activeNote = (stage: (typeof STAGES)[number]): string => {
    if (phase === "interview") return ko ? "위 질문에 답해 주세요" : "Answer the questions above";
    if (phase === "mcp-review") return ko ? "연결할 도구를 골라 주세요" : "Choose which connections to use";
    if (phase === "runtime-approval") return ko ? "사용할 모델을 골라 주세요" : "Choose the model to use";
    return liveness?.activity || (ko ? stage.sub : stage.subEn);
  };

  const requestComposer = (
    <div
      className={styles.draftCard}
      data-tour-id="build.request"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDrop={(e) => { e.preventDefault(); if (editingLocked) return; addDroppedFiles(e.dataTransfer.files); }}
    >
      <textarea
        ref={requestInputRef}
        id="build-conversation-request"
        aria-label={ko ? "에이전트 지침과 요청" : "Agent instructions and request"}
        onPaste={(e) => {
          // 붙여넣은 사진·영상·파일도 첨부가 된다(글만 붙여넣으면 글 그대로).
          const pasted = Array.from(e.clipboardData?.files ?? []);
          if (!pasted.length || editingLocked) return;
          e.preventDefault();
          void addDroppedFiles(pasted);
        }}
        value={request}
        onChange={(e) => { if (canEditBuildDraft()) setBuildRequest(e.target.value); }}
        disabled={editingLocked}
        placeholder={ko ? "에이전트가 할 일과 원하는 결과를 적어 주세요" : "Describe what the agent should do and the result you want"}
        rows={6}
        className="titlebar-nodrag"
      />
      {attachments.length > 0 && (
        <div className={`${styles.attachments} titlebar-nodrag`} data-build-attachments="true">
          {/* 사진·영상은 썸네일, 그 밖의 파일·폴더는 아이콘+이름 타일 — 한 줄 가로 띠, 각각 × (media-carousel) */}
          <MediaStrip
            variant="composer"
            locale={ko ? "ko" : "en"}
            items={attachments.map((a, i): MediaStripItem => {
              const preview = attachmentPreviews.get(a.path);
              return {
                key: a.path,
                kind: a.kind === "dir" ? "folder" : preview ? mediaKindOf(undefined, a.name) : "file",
                name: a.name,
                src: preview,
                thumbSrc: preview && mediaKindOf(undefined, a.name) === "image" ? preview : undefined,
                ...(!busy ? { onRemove: () => { if (canEditBuildDraft()) removeAttachment(i); } } : {}),
              };
            })}
          />
        </div>
      )}
      {attachmentSkipped.length > 0 && (
        <p className={styles.fieldNote} role="alert">
          {ko ? `첨부하지 못했습니다: ${attachmentSkipped.join(", ")}` : `Could not attach: ${attachmentSkipped.join(", ")}`}
        </p>
      )}
      <div className={styles.draftBar} data-tour-id="build.interview">
        <button type="button" className={`${styles.chipButton} titlebar-nodrag`} disabled={editingLocked} title={ko ? "사진·영상·문서·에이전트나 스킬 폴더" : "Photos, videos, documents, agent or skill folders"} onClick={() => fileInputRef.current?.click()}>
          <IconPaperclip size={14} /> {ko ? "파일 첨부" : "Attach files"}
        </button>
        <button type="button" className={`${styles.chipButton} titlebar-nodrag`} disabled={editingLocked} onClick={() => void attachFolder()}>
          <IconFolder size={14} /> {ko ? "폴더 첨부" : "Attach folder"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addDroppedFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {startPending && !busy ? (
          <span className={styles.draftStatus} role="status">{ko ? "생성 폴더를 확인하는 중" : "Checking the output folder"}</span>
        ) : (
          <button
            type="button"
            onClick={startNow}
            disabled={startPending || Boolean(startBlocker)}
            /* 막는 사유 문장이 아래에 있는데 단추에는 없었다 — 같은 문장을 붙인다. */
            title={startBlocker || undefined}
            className={`${styles.primary} ${styles.startButton} titlebar-nodrag`}
          >
            {ko ? "딥인터뷰로 빌드 시작" : "Start build (deep interview)"}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className={`rd build-root ${styles.root}`} data-build-screen={screen}>
      <div className="titlebar-drag build-window-drag" />
      <main className="build-scroll" hidden={connectionsOpen}>
          <Suspense fallback={null}>
            <OneSuggestionReviewHandoffBanner surface="build" locale={locale} onReviewSeed={applyOneReviewSeed} />
          </Suspense>

        {saved ? <BuildSavedWindow key={saved.buildKey ?? saved.agentId} ko={ko} buildKey={saved.buildKey} agentId={saved.agentId} agentName={saved.name} onBack={() => setSaved(null)} onContinueEdit={continueEdit} /> : reattaching ? <div className={styles.empty} role="status"><strong>{reattachProblem ? (ko ? "제작 상태를 확인하지 못했습니다" : "Build status could not be confirmed") : (ko ? "진행 중인 제작을 확인하고 있습니다…" : "Checking for an ongoing build…")}</strong><p>{ko ? "이전 빌드와 겹치지 않도록 확인이 끝날 때까지 새 제작을 기다립니다. 응답이 지연되면 작업공간으로 돌아갈 수 있습니다." : "New builds wait until this check finishes to avoid overlapping an earlier build. You can return to the workspace while the response is delayed."}</p><Link className={styles.quietButton} href="/workspace">{ko ? "작업공간으로 돌아가기" : "Return to workspace"}</Link></div> : screen !== "editor" ? <BuildLaunch ko={ko} screen={screen} request={request} onRequest={(text) => { if (canEditBuildDraft()) setBuildRequest(text); else setScreen("editor"); }}
          hasBuild={phase !== "idle" || Boolean(request)} onResume={() => setScreen("editor")}
          onHome={() => { if (!getUiStartPending()) setScreen("home"); }} onNew={() => { if (getUiStartPending()) { setScreen("editor"); return; } if (startFreshBuild()) setScreen("intro"); else setScreen("editor"); }}
          onBlank={() => openBuildDraft("")}
          onCompose={openBuildDraft} onAttachFiles={(files) => void addDroppedFiles(files)} attachmentCount={attachments.length}
          onOpenBuild={(item) => { if ((item.state === "building" || item.state === "question") && getBuildSnapshot().phase !== "idle") setScreen("editor"); else setSaved({ buildKey: item.id }); }} /> : <div className={`build-shell ${styles.workbench}`}>
          <header className={styles.toolbar}>
            <button type="button" className={styles.backButton} disabled={startPending} aria-label={ko ? "에이전트 목록으로" : "Back to agents"} onClick={() => { if (!getUiStartPending()) setScreen("home"); }}><IconArrowLeft size={18} /></button>
            <h1 className={styles.toolbarTitle}>{registeredEntity?.name || (ko ? "새 에이전트" : "New agent")}</h1>
            <div className={styles.toolbarActions}>
              {liveKey.key && (phase === "running" || phase === "done") && <button type="button" className={styles.quietButton} aria-pressed={filesView} onClick={() => setFilesView(!filesView)}>{ko ? "파일" : "Files"}</button>}
              {phase === "done" && !canContinueCompletedBuild() && <button onClick={startFreshBuild} className={styles.quietButton}>{ko ? "새 빌드" : "New build"}</button>}
              {busy && <button type="button" className={styles.stopButton} onClick={cancelBuild}>{ko ? "중지" : "Stop"}</button>}
            </div>
          </header>
          <div className={`${styles.editorLayout} ${showLiveFiles ? styles.editorLayout3 : ""}`}>
            <section className={styles.conversation} aria-label={ko ? "에이전트 제작 대화" : "Agent build conversation"}>
              {draft ? requestComposer : request ? <div className={styles.requestRow}><div className={styles.requestBubble} data-tour-id="build.request">{request}</div></div> : null}
              {!draft && <div className={styles.conversationHeading}><img src="/brand/agentlas-mark.png" alt="" /><span>Agentlas</span></div>}
              {/* 진행 목록이 바뀌어도 화면 낭독기가 알 수 있게 — 보이는 말은 목록 한 곳뿐이다. */}
              {busy && <span className="sr-only" role="status" aria-live="polite">{(ko ? STAGES[activeStageIndex].label : STAGES[activeStageIndex].labelEn)}: {activeNote(STAGES[activeStageIndex])}</span>}
              {draft && (startBlocker || folderMsg) && !startBlockerIsEngine && (
                <div role="status" className={styles.fieldNote}>
                  {startBlocker || folderMsg}
                </div>
              )}

          {engineMissing && (
            <div className="build-alert">
              <IconShield size={15} />
              <div className="key-status-banner-copy">
                <strong title={status?.reason || undefined}>
                  {ko ? "제작 엔진을 사용할 수 없습니다" : "The build engine is unavailable"}
                </strong>
                <span>
                  {ko
                    ? "엔진은 앱에 들어 있어요. 앱을 다시 시작해 보세요. 계속 안 되면 설정에서 엔진을 업데이트하세요."
                    : "The engine ships with the app. Restart the app; if it keeps failing, update the engine in Settings."}
                </span>
              </div>
            </div>
          )}

          {/* 지금 사람에게 필요한 것은 진행 목록 위에 둔다 — 목록 아래에 두면 질문이 화면 밖으로 밀린다. */}
          {phase === "mcp-review" && mcpPlan && (
            <McpBuildInterviewCard
              plan={mcpPlan}
              ko={ko}
              onApprove={(selectedIds) => void approveBuildMcpPlan(selectedIds)}
              onCancel={cancelBuild}
            />
          )}

          {phase === "runtime-approval" && pendingAllocation && (
            <section className={styles.needCard}>
              <h2 className={styles.needTitle}>{ko ? "이 빌드에 더 상위 모델을 쓸까요?" : "Use a higher model for this build?"}</h2>
              <p className={styles.needText}>
                {ko
                  ? `이 작업이 어렵다고 판단해 ${describeAllocationRuntime(pendingAllocation.allocated)} 사용을 제안합니다. 내가 고른 건 ${describeAllocationRuntime(pendingAllocation.current)}입니다.`
                  : `This work was judged demanding, so ${describeAllocationRuntime(pendingAllocation.allocated)} is proposed. Your own choice is ${describeAllocationRuntime(pendingAllocation.current)}.`}
              </p>
              <p className={styles.needText}>
                {ko
                  ? "상위 모델은 결과가 더 좋을 수 있지만 구독·크레딧을 더 씁니다. 어느 쪽을 고르든 이 빌드는 그 모델로 고정됩니다."
                  : "A higher model may produce better results but uses more of your subscription/credits. Either choice is pinned for this build."}
              </p>
              <div className={styles.needActions}>
                <button onClick={cancelBuild} className={`${styles.quietButton} titlebar-nodrag`}>{ko ? "모델 선택 취소" : "Cancel model review"}</button>
                <button
                  className={styles.secondary}
                  onClick={() => void resolveRuntimeEscalation(false)}
                >
                  {ko ? `내 선택 유지 (${describeAllocationRuntime(pendingAllocation.current)})` : `Keep my choice (${describeAllocationRuntime(pendingAllocation.current)})`}
                </button>
                <button
                  className={styles.primary}
                  onClick={() => void resolveRuntimeEscalation(true)}
                >
                  {ko ? `${describeAllocationRuntime(pendingAllocation.allocated)} 사용` : `Use ${describeAllocationRuntime(pendingAllocation.allocated)}`}
                </button>
              </div>
            </section>
          )}

          {awaitingReply && pendingQuestions.length > 0 && (
            <section className={styles.needCard} data-tour-id="build.interview">
              {!workspaceGrant && <button type="button" className={styles.quietButton} onClick={() => void reauthorizeConversationWorkspace()}>{ko ? "이전 작업 폴더 다시 선택" : "Select previous workspace"}</button>}
              <h2 className={styles.needTitle}>{ko ? "몇 가지만 알려 주세요" : "A few quick questions"}</h2>
              {pendingQuestions.map((q) => (
                <div key={q.id} className={styles.question}>
                  <div className={styles.questionText}>{q.question}</div>
                  <div className={styles.options}>
                    {q.options.map((o) => {
                      const selected = (selectedOptions[q.id] ?? []).includes(o.label);
                      return (
                        <button
                          key={o.label}
                          type="button"
                          className={`${styles.option} titlebar-nodrag`}
                          data-selected={selected ? "true" : "false"}
                          data-multi={q.multiSelect ? "true" : "false"}
                          aria-pressed={selected}
                          title={o.description ? `${o.label}: ${o.description}` : o.label}
                          onClick={() => toggleInterviewOption(q.id, o.label)}
                        >
                          <span className={styles.optionMark} aria-hidden="true">
                            <IconCheck size={12} />
                          </span>
                          <span className={styles.optionBody}>
                            <strong>{o.label}</strong>
                            {o.description && <span>{o.description}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    value={questionNotes[q.id] ?? ""}
                    onChange={(e) => setQuestionNote(q.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) confirmInterviewReply();
                    }}
                    rows={1}
                    placeholder={ko ? "직접 답하기" : "Answer in your own words"}
                    className={`${styles.answerInput} titlebar-nodrag`}
                  />
                </div>
              ))}
              <div className={styles.answerFoot}>
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) confirmInterviewReply();
                  }}
                  rows={2}
                  placeholder={ko ? `추가로 알려 줄 것 (${shortcutLabel("Enter", uiOs)} 확인)` : `Anything else? (${shortcutLabel("Enter", uiOs)} to confirm)`}
                  className={`${styles.answerInput} titlebar-nodrag`}
                />
                <div className={`${styles.needActions} ${styles.stickyActions}`}>
                  <button type="button" onClick={resetBuild} className={`${styles.quietButton} titlebar-nodrag`}>{ko ? "인터뷰 취소" : "Cancel interview"}</button>
                  <button
                    type="button"
                    onClick={confirmInterviewReply}
                    disabled={!composedReply.trim()}
                    className={`${styles.primary} titlebar-nodrag`}
                  >
                    {ko ? (selectedCount > 0 ? `선택 ${selectedCount}개 확인` : "확인") : selectedCount > 0 ? `Confirm ${selectedCount}` : "Confirm"}
                  </button>
                </div>
              </div>
            </section>
          )}

          {phase === "error" && buildError && (
            <section className={styles.needCard} role="alert">
              <h2 className={styles.needTitle}>{restoredCompletionNeedsReview() ? (ko ? "이전 결과 확인 필요" : "Previous result needs review") : (ko ? "제작이 멈췄어요" : "The build stopped")}</h2>
              <p className={styles.needText}>{buildError.message}</p>
              <div className={`${styles.needActions} ${styles.needActionsPrimaryFirst}`}>
                {buildError.kind === "workspace-unavailable" && (
                  <button className={`${styles.primary} titlebar-nodrag`} onClick={() => void reauthorizeWorkspace()}>
                    {ko ? "생성 폴더 다시 선택" : "Choose output folder again"}
                  </button>
                )}
                {recoverable && buildError.kind !== "workspace-unavailable" && (
                  <button onClick={() => void resumeBuild()} className={`${styles.primary} titlebar-nodrag`}>
                    {ko ? "보존된 파일에서 이어서 빌드" : "Resume from saved files"}
                  </button>
                )}
                <button className={`${styles.secondary} titlebar-nodrag`} onClick={resetBuild}>
                  {ko ? "요청 유지하고 다시 준비" : "Keep request and prepare again"}
                </button>
                <button onClick={startFreshBuild} className={`${styles.quietButton} titlebar-nodrag`}>{ko ? "새 빌드" : "New build"}</button>
              </div>
            </section>
          )}

          {draft && <p className={styles.fieldNote}>{progressLabel}</p>}
          {phase !== "done" && (
            <ol className={styles.progress} data-tour-id="build.pipeline" data-preview={draft ? "true" : undefined} aria-label={progressLabel}>
              {STAGES.map((stage, i) => {
                const state = stageStates[i];
                return (
                  <StageRow
                    key={stage.key}
                    stage={stage}
                    state={state}
                    ko={ko}
                    meta={state === "active"
                      ? (phase === "running"
                        ? <><span>{ko ? "진행 중" : "In progress"}</span> <ElapsedClock startedAt={stageStartedAt} /></>
                        : waiting ? <span>{ko ? "당신 차례" : "Your turn"}</span> : null)
                      : state === "error" ? <span>{ko ? "멈춤" : "Stopped"}</span> : null}
                    note={state === "active" ? activeNote(stage) : null}
                    silent={state === "active" && phase === "running" && Boolean(liveness && liveness.silentMs >= 45_000)}
                  />
                );
              })}
            </ol>
          )}

          {mcpReceipt && phase !== "mcp-review" && (
            <McpAttachmentReceiptCard receipt={mcpReceipt} ko={ko} />
          )}

          {phase === "done" && result && (
            <section className={styles.resultCard} aria-label={ko ? "제작 결과" : "Build result"}>
              <span className={styles.resultMark} aria-hidden="true"><IconCheck size={14} /></span>
              <div className={styles.resultText}>
                <strong>{ko ? "만들기를 마쳤어요" : "Build finished"}</strong>
                <span>
                  {registered
                    ? ko ? "패키지 준비됨 · 조직도에 추가됨" : "Package ready · added to org chart"
                    : ko ? "패키지 준비됨" : "Package ready"}
                </span>
              </div>
              <button onClick={installToLibrary} className={`${styles.primary} titlebar-nodrag`}>
                {registeredEntity?.kind === "agent"
                  ? ko ? "내 에이전트에서 열기" : "Open in My Agents"
                  : ko ? "조직도에서 열기" : "Open org chart"}
              </button>
            </section>
          )}

          {canContinueCompletedBuild() && (
            <section className={styles.followUp}>
              {!workspaceGrant && <button type="button" className={styles.quietButton} onClick={() => void reauthorizeConversationWorkspace()}>{ko ? "이전 작업 폴더 다시 선택" : "Select previous workspace"}</button>}
              <label htmlFor="build-follow-up">{ko ? "이 작업 이어가기" : "Continue this work"}</label>
              <div className={styles.followCard}>
                <textarea id="build-follow-up" className="titlebar-nodrag" rows={2}
                  value={followUp} onChange={(event) => setFollowUp(event.target.value)}
                  placeholder={ko ? "수정하거나 추가할 내용을 입력하세요" : "Describe what to change or add"} />
                <div className={styles.followBar}>
                  <button onClick={startFreshBuild} className={`${styles.quietButton} titlebar-nodrag`}>{ko ? "새 빌드" : "New build"}</button>
                  <button type="button" className={styles.secondary} disabled={!followUp.trim()}
                    onClick={() => void continueCompletedBuild(followUp)}>{ko ? "이어서 요청" : "Continue"}</button>
                </div>
              </div>
            </section>
          )}

          {/* 실행 중과 실패 직후에는 펼쳐 둔다. 접힌 채로 두면 "작업 중"이라는 글자만
              보이고 그 아래가 비어 있어, 아무 일도 안 일어나는 것처럼 읽힌다
              완료된 빌드만 접어 둔다. */}
          {log.length > 0 && (
            <details
              className={`build-card build-log-card ${styles.logCard}`}
              data-tour-id="build.log"
              open={running || phase === "error"}
            >
              <summary className="build-card-head">
                <span>{ko ? "진행 세부사항" : "Activity details"}</span>
              </summary>
              <div className="build-log-body">
                <BuildLogRows log={log} ko={ko} />
                {/* One replaceable tail row, never appended history. It is the
                    only thing in this box while a runtime streams nothing. */}
                {liveness && (
                  <div data-kind="heartbeat" className="build-log-tail">
                    <span className="build-log-time">{fmtLogTime(liveness.at)}</span>
                    <span className="build-log-tail-dot" />
                    <span>
                      {liveness.activity}
                      {liveness.silentMs >= 45_000
                        ? ko ? " · 시간이 더 필요한 단계지만 계속 작업 중입니다." : " · This step is taking longer, but work is continuing."
                        : ""}
                    </span>
                  </div>
                )}
                <div ref={logEndRef} />
              </div>
            </details>
          )}
            </section>
            {showLiveFiles && liveKey.key && <LiveBuildFiles ko={ko} buildKey={liveKey.key} title={liveKey.title} runId={runId} running={phase === "running"} />}
            <aside className={styles.inspector} hidden={showLiveFiles} aria-label={ko ? "에이전트 설정과 결과" : "Agent settings and result"}>
              <div className={styles.inspectorInner}>
              {/* problemsInBanner: the header pill ("Keys healthy") is gone — a key or usage problem is told once, in this banner, and only when it concerns the selected engine. */}
              <KeyStatusBanner mode="banner" relevantProvider={selectedRuntimeProviderLabel} relevantRuntime={selectedRuntimeBannerRuntime} />
              {phase === "done" && result ? (
                <>
                  <section className={styles.panel}>
                    <h2 className={styles.panelTitle}>{ko ? "만들어진 파일" : "Files"}</h2>
                    <ArtifactPreview workspace={result.workspace} readScope={result.readScope} ko={ko} />
                  </section>
                  <section className={styles.panel}>
                    <SecurityScanBlock scan={result.securityScan} folder={result.workspace} scope={result.readScope} ko={ko} />
                  </section>
                  <section className={styles.panel}>
                    <div className="build-upload-choice">
                      <h2 className={styles.panelTitle}>{ko ? "공개 배포는 별도 선택" : "Public distribution is a separate choice"}</h2>
                      <label className={styles.consent}>
                        <input type="checkbox" checked={publicSourceConsent} onChange={(event) => setPublicSourceConsent(event.target.checked)} />
                        <span>{ko
                          ? "Agent Space에서 공개용 패키지의 읽을 수 있는 소스 파일을 볼 수 있도록 허용합니다. 원본 빌드 폴더는 변경되지 않습니다."
                          : "Allow readable source files from the public package to appear in Agent Space. The original build folder stays unchanged."}</span>
                      </label>
                      <button onClick={() => void uploadToPublicHub()} className={`${styles.secondary} ${styles.hubButton} titlebar-nodrag`}>
                        <strong>{ko ? "허브 (공개)" : "Hub (public)"}</strong>
                        <span>{ko ? "허브 레지스트리에 공개 후보로 제출" : "Submit to the public Hub registry"}</span>
                      </button>
                    </div>
                  </section>
                  {resultHasSecurityAdvisory && (
                    <div role="status" className={styles.fieldNote}>
                      {ko
                        ? "안전 점검 결과는 참고용입니다. 점검 항목은 계속 볼 수 있고, 설치·Cloud 저장·Hub 공개도 그대로 진행할 수 있습니다."
                        : "Safety findings are advisory. Findings and receipts remain visible, and install, Cloud save, and Hub publish can continue."}
                    </div>
                  )}
                  {actionMsg && <div className={styles.fieldNote}>{actionMsg}</div>}
                  <BuildResources connectionsActive={connectionsOpen} connectionsTarget={connectionsTarget} onConnectionsOpenChange={setConnectionsOpen} connectionsCloseRequest={connectionsCloseRequest} ko={ko} canAttach={false} canConfigure={false} onAttachFolder={() => void attachFolder()} registered={registered ? registeredEntity : null} />
                </>
              ) : draft ? (
                <>
                  <section className={styles.panel}>
                    <h2 className={styles.panelTitle}>{ko ? "종류" : "Type"}</h2>
                    <div className={styles.kindList} role="group" aria-label={ko ? "에이전트 종류" : "Agent type"}>
                      {MODES.map((m) => {
                        const active = mode === m.id;
                        const Icon = m.icon;
                        return (
                          <button
                            key={m.id}
                            onClick={() => { if (canEditBuildDraft()) setBuildMode(active ? "" : m.id); }}
                            disabled={editingLocked}
                            className={`${styles.kind} titlebar-nodrag`}
                            data-active={active ? "true" : "false"}
                            data-mode={m.id}
                            aria-pressed={active}
                          >
                            <span className={styles.kindIcon} aria-hidden="true"><Icon size={16} /></span>
                            <span className={styles.kindText}>
                              <strong>{ko ? m.label : m.labelEn}</strong>
                              <span>{ko ? m.desc : m.descEn}</span>
                            </span>
                            <span className={styles.kindCheck} aria-hidden="true"><IconCheck size={12} /></span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                  <section className={`${styles.panel} ${styles.selectHost}`}>
                    <label className={styles.panelTitle} htmlFor="build-model-select">{ko ? "빌드 모델" : "Build model"}</label>
                    <Select
                      id="build-model-select"
                      className="build-model-select titlebar-nodrag"
                      value={runtimeKey(runtime)}
                      onChange={(e) => onSelectRuntime(e.target.value)}
                      disabled={editingLocked}
                    >
                      <option value="">{ko ? "자동 선택 (활성 엔진)" : "Auto (active engine)"}</option>
                      {runtimes.flatMap((r) => {
                        const key = `${r.kind}:${r.source}`;
                        const blocked = runtimeUsageBlocked(r, usage);
                        const suffix = `${r.active ? (ko ? " · 활성" : " · active") : ""}${blocked ? usageExhaustedSuffix(ko) : ""}`;
                        const models = modelsByRuntime[key] ?? [];
                        // 모델을 아는 런타임은 모델까지 고르게 한다. 모르는 런타임은
                        // 종전처럼 런타임 한 줄로 남긴다(없는 선택지를 지어내지 않는다).
                        if (models.length === 0) {
                          return [(
                            <option key={key} value={key} disabled={blocked}>
                              {engineLabel(r, ko)}{r.model ? ` · ${r.model}` : ""}{suffix}
                            </option>
                          )];
                        }
                        return models.map((m) => {
                          const modelBlocked = runtimeUsageBlocked(r, usage, m.id);
                          const modelSuffix = `${r.active ? (ko ? " · 활성" : " · active") : ""}${modelBlocked ? usageExhaustedSuffix(ko) : ""}`;
                          return (
                            <option key={`${key}::${m.id}`} value={`${key}::${m.id}`} disabled={modelBlocked}>
                              {engineLabel(r, ko)} · {m.label}{modelSuffix}
                            </option>
                          );
                        });
                      })}
                    </Select>
                  </section>
                  <section className={styles.panel}>
                    <h2 className={styles.panelTitle}>{ko ? "저장 폴더" : "Output folder"}</h2>
                    <button onClick={pickWorkspace} disabled={editingLocked} className={`${styles.folderButton} titlebar-nodrag`}>
                      <IconFolder size={15} />
                      <span>{folderLabel || (ko ? "생성 폴더 선택" : "Choose output folder")}</span>
                    </button>
                  </section>
                  <BuildResources connectionsActive={connectionsOpen} connectionsTarget={connectionsTarget} onConnectionsOpenChange={setConnectionsOpen} connectionsCloseRequest={connectionsCloseRequest} ko={ko} canAttach={!editingLocked} canConfigure={!editingLocked && !reattaching} onAttachFolder={() => void attachFolder()} registered={null} />
                </>
              ) : (
                <>
                  <section className={styles.summaryCard}>
                    {kindMeta && <h2 className={styles.summaryHead}><span className={styles.kindIcon} aria-hidden="true"><kindMeta.icon size={16} /></span>{ko ? kindMeta.label : kindMeta.labelEn}</h2>}
                    <dl className={styles.facts}>
                      <div><dt>{ko ? "모델" : "Model"}</dt><dd>{runtimeSummary}</dd></div>
                      {folderLabel && <div><dt>{ko ? "저장 폴더" : "Folder"}</dt><dd className={styles.mono}>{folderLabel}</dd></div>}
                      {attachments.length > 0 && <div><dt>{ko ? "첨부" : "Attached"}</dt><dd>{ko ? `${attachments.length}개` : String(attachments.length)}</dd></div>}
                    </dl>
                  </section>
                  {phase !== "error" && (
                    <div className={styles.pendingFiles}>
                      <IconFolder size={18} />
                      <p>{ko ? "완료되면 만들어진 파일과 결과가 여기에 나타나요." : "The files and result appear here when it finishes."}</p>
                    </div>
                  )}
                </>
              )}
              </div>
            </aside>
          </div>
        </div>}
      </main>
      <section className={connectionsStyles.screen} hidden={!connectionsOpen} aria-label={ko ? "서비스 연결 설정" : "Service connection settings"}>
        <header className={connectionsStyles.header}><button ref={connectionsBack} className="titlebar-nodrag" type="button" onClick={() => setConnectionsCloseRequest(value => value + 1)}>{ko ? "← 제작으로 돌아가기" : "← Back to Build"}</button><h1>{ko ? "서비스 연결" : "Service connections"}</h1></header>
        <div className={connectionsStyles.layout}><nav aria-label={ko ? "설정 메뉴" : "Settings menu"}><span aria-current="page">{ko ? "서비스 연결" : "Service connections"}</span></nav><div className={connectionsStyles.content} ref={setConnectionsTarget} /></div>
      </section>
      <CloudSaveChoiceDialog
        open={Boolean(cloudSaveChoice && (cloudSaveChoice.status === "pending" || cloudSaveChoice.status === "presented" || cloudSaveChoice.status === "uploading"))}
        choiceId={cloudSaveChoice?.id ?? ""}
        packageName={cloudSaveChoice?.workspace.split(/[\\/]/).pop() || (ko ? "에이전트 패키지" : "Agent package")}
        ko={ko}
        busy={cloudSaveChoice?.status === "uploading"}
        error={cloudChoiceError}
        progress={cloudUploadProgress}
        onCloud={() => void saveBuildChoiceToCloud()}
        onLocalOnly={keepBuildLocalOnly}
      />
    </div>
  );
}

// 답장 스캐폴딩은 반드시 UI locale 을 따른다 — 영어 모드에서 "질문:/선택:"으로 조립해 보내면
// 런타임 언어 가이드가 한국어 입력으로 판정해 다음 턴부터 인터뷰가 한국어로 고착된다.
function composeInterviewReply(
  questions: ChatQuestion[],
  selectedOptions: Record<string, string[]>,
  questionNotes: Record<string, string>,
  batchNote: string,
  ko: boolean,
): string {
  const chunks: string[] = [];
  for (const q of questions) {
    const selected = selectedOptions[q.id] ?? [];
    const note = (questionNotes[q.id] ?? "").trim();
    if (!selected.length && !note) continue;
    const lines = [`${ko ? "질문" : "Question"}: ${q.question}`];
    if (selected.length) {
      lines.push(ko ? "선택:" : "Selected:");
      selected.forEach((label, index) => lines.push(`${index + 1}. ${label}`));
    }
    if (note) lines.push(`${ko ? "답변" : "Answer"}: ${note}`);
    chunks.push(lines.join("\n"));
  }
  const manual = batchNote.trim();
  if (manual) chunks.push(`${ko ? "추가 메모" : "Additional note"}: ${manual}`);
  return chunks.join("\n\n");
}

/** 단계 한 줄: 이름 + 상태(아이콘·시간). 지금 단계만 한 문장(note)이 붙는다. 상태 낱말은 meta 한 곳에서만 말한다. */
function StageRow({
  stage,
  state,
  ko,
  meta,
  note,
  silent,
}: {
  stage: (typeof STAGES)[number];
  state: StageState;
  ko: boolean;
  meta: ReactNode;
  note: string | null;
  silent: boolean;
}) {
  return (
    <li className={styles.stage} data-state={state} aria-current={state === "active" ? "step" : undefined}>
      <span className={styles.stageIcon} aria-hidden="true">
        {state === "done" ? <IconCheck size={12} strokeWidth={2.4} /> : state === "error" ? <IconClose size={12} strokeWidth={2.4} /> : state === "active" ? <span className={styles.spinner} /> : null}
      </span>
      <span className={styles.stageName}>{ko ? stage.label : stage.labelEn}</span>
      {meta ? <span className={styles.stageMeta}>{meta}</span> : <span />}
      {state === "done" && <span className="sr-only">{ko ? "완료" : "Done"}</span>}
      {note && (
        <span className={styles.stageNote}>
          {note}
          {silent && <em>{ko ? "시간이 더 필요한 단계 · 계속 작업 중" : "Longer step · still working"}</em>}
        </span>
      )}
    </li>
  );
}

// ── 산출물 미리보기 — "무엇이·어디에 만들어졌나"를 실제 디스크에서 보여준다(소유의 물증). ──
const KEY_ARTIFACTS = ["AGENTS.md", "AGENT.md", "agentlas.json", ".agentlas", "README.md", "system-prompt.md"];
function ArtifactPreview({ workspace, readScope, ko }: { workspace: string; readScope: FsReadScope; ko: boolean }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipc()?.fs.listDirectory(workspace, readScope, true)
      .then((d) => { if (alive) setListing(d); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [readScope, workspace]);
  const entries = listing?.entries ?? [];
  return (
    <div className="build-artifact">
      <div className="build-artifact-path" title={workspace}>
        <IconFolder size={14} />
        <span>{workspace}</span>
      </div>
      {err && <div className="build-artifact-empty">{ko ? "폴더를 읽을 수 없습니다" : "Could not read folder"}: {err}</div>}
      {!err && entries.length === 0 && <div className="build-artifact-empty">{ko ? "생성된 파일을 확인하는 중…" : "Checking generated files…"}</div>}
      {entries.length > 0 && (
        <ul className="build-artifact-tree">
          {entries.map((n) => (
            <li key={n.path} data-key={KEY_ARTIFACTS.includes(n.name) ? "true" : "false"}>
              {n.kind === "dir" ? <IconFolder size={13} /> : <span className="build-artifact-filedot" />}
              <span>{n.name}{n.kind === "dir" ? "/" : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 안전 점검 참고 — 결과와 영수증을 표시하되 사용자 작업을 차단하지 않는다. ──
function parseScan(scan: unknown, ko: boolean): {
  unknown: boolean;
  tone: "ok" | "warn" | "block";
  pass: number;
  warn: number;
  blocker: number;
  items: { severity: string; message: string; file?: string }[];
} {
  const disposition = buildScanDisposition(scan);
  const normalized = buildScanFindings(scan);
  if (!normalized) return { unknown: true, tone: "warn", pass: 0, warn: 0, blocker: 0, items: [] };
  const items = normalized.map((finding) => ({
    severity: finding.severity,
    message: finding.message || (ko ? "항목" : "finding"),
    file: finding.file,
  }));
  const blocker = items.filter((i) => buildScanSeverityBucket(i.severity) === "blocked").length;
  const warn = items.filter((i) => buildScanSeverityBucket(i.severity) === "warning").length;
  const pass = items.length - blocker - warn;
  const tone = disposition === "blocked" ? "block" : disposition === "warning" ? "warn" : "ok";
  return { unknown: false, tone, pass, warn, blocker, items };
}

/** 안전 점검 참고 + 수동 재스캔 — 빌드 결과의 정적 보안 스캔을 사용자가 원할 때 다시 돌린다.
 *  (기존엔 hephaestus.securityScan IPC가 렌더러에서 한 번도 호출되지 않았다 — 결과 표시 전용.) */
function SecurityScanBlock({ scan, folder, scope, ko }: { scan: unknown; folder: string; scope: FsReadScope; ko: boolean }) {
  const [busy, setBusy] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const rescan = async () => {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    setRescanError(null);
    try {
      const res = await api.hephaestus.securityScan({ folder, scope, strict: true });
      // HephaestusCommandResult — json 필드가 스캔 결과. 없으면 원본 유지(표시 파서가 unknown 처리).
      const next = (res as { json?: unknown })?.json ?? res;
      updateBuildSecurityScan(next);
    } catch (error) {
      // 엔진 미가용 — 기존 결과를 통과로 바꾸지 않고 사용자에게 다음 행동을 남긴다.
      setRescanError(
        ko
          ? `재스캔을 완료하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
          : `Could not complete the re-scan: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.scanBlock}>
      <VerifyGate scan={scan} ko={ko} />
      <button
        onClick={() => void rescan()}
        disabled={busy}
        className={`${styles.chipButton} titlebar-nodrag`}
      >
        {busy ? (ko ? "스캔 중…" : "Scanning…") : ko ? "보안 재스캔" : "Re-run security scan"}
      </button>
      {rescanError && <div role="alert" className="build-action-msg">{rescanError}</div>}
    </div>
  );
}

function VerifyGate({ scan, ko }: { scan: unknown; ko: boolean }) {
  const p = parseScan(scan, ko);
  return (
    <div className="build-verify" data-tone={p.tone}>
      <div className="build-verify-head">
        <IconShield size={14} />
        <strong>{ko ? "안전 점검 (참고)" : "Safety check (advisory)"}</strong>
      </div>
      {p.unknown ? (
        <p className="build-verify-note">
          {ko
            ? "보안 스캔 결과를 확인하지 못했습니다. 작업은 차단되지 않으며, 필요하면 재스캔해 참고 결과를 갱신하세요."
            : "The security scan result is unavailable. Work is not blocked; re-run the scan if you want to refresh the advisory."}
        </p>
      ) : p.items.length === 0 ? (
        <p className="build-verify-note">{ko ? "정적 보안 스캔 통과 — 차단·주의 항목 없음." : "Static security scan passed — no blockers or warnings."}</p>
      ) : (
        <>
          <p className="build-verify-summary">
            {ko ? "통과" : "pass"} {p.pass} · {ko ? "주의" : "warn"} {p.warn}
            {p.blocker > 0 ? ` · ${ko ? "높음" : "high"} ${p.blocker}` : ""}
          </p>
          {p.items.slice(0, 5).map((f, i) => (
            <div key={i} className="build-verify-item" data-sev={f.severity}>
              <span className="build-verify-sev">{f.severity}</span> {f.message}
              {f.file ? ` (${f.file})` : ""}
            </div>
          ))}
          <p className="build-verify-note">{ko ? "모든 항목은 참고용이며 설치·저장·공개를 막지 않습니다. 공개 작업은 여전히 사용자가 직접 선택해야 합니다." : "All findings are advisory and do not block install, save, or publish. Publishing still requires an explicit user action."}</p>
        </>
      )}
    </div>
  );
}
