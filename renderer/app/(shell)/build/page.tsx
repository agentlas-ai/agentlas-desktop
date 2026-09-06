"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import {
  IconBuilding,
  IconChevronRight,
  IconUsers,
  IconWand,
  IconFolder,
  IconRoute,
  IconSearch,
  IconShield,
  IconStore,
  IconCheck,
} from "@/components/Icon";
import { grantForDroppedFile, ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { announceAgentRosterChange } from "@/lib/agent-roster-events";
import { KeyStatusBanner } from "@/components/KeyStatusBanner";
import { ElapsedClock } from "@/components/ElapsedClock";
import { McpBuildInterviewCard } from "@/components/build/McpBuildInterviewCard";
import { McpAttachmentReceiptCard } from "@/components/build/McpAttachmentReceiptCard";
import { CloudSaveChoiceDialog } from "@/components/build/CloudSaveChoiceDialog";
import { OneSuggestionReviewHandoffBanner, type OneReviewSeedApplyResult } from "@/components/one/OneSuggestionReviewHandoff";
import type { DirListing, FsReadScope, HephaestusStatus, OneSuggestionReviewSeed, RuntimeSelection, RuntimeStatus, UsageSnapshot } from "@/lib/types";
import {
  subscribe as buildSubscribe,
  getSnapshot as getBuildSnapshot,
  setRequest as setBuildRequest,
  setMode as setBuildMode,
  setWorkspace as setBuildWorkspace,
  setRuntime as setBuildRuntime,
  startBuild,
  approveBuildMcpPlan,
  describeAllocationRuntime,
  resolveRuntimeEscalation,
  answerBuild,
  cancelBuild,
  resumeBuild,
  resetBuild,
  startFreshBuild,
  addAttachments,
  removeAttachment,
  updateBuildSecurityScan,
  presentBuildCloudSaveChoice,
  beginBuildCloudSave,
  finishBuildCloudSave,
  chooseBuildLocalOnly,
  type Mode,
  type BuildAttachment,
  reattachRunningBuild,
} from "@/lib/build-session";
import { buildScanDisposition, buildScanFindings, buildScanSeverityBucket } from "@/lib/build-scan";
import type { ChatQuestion } from "@/components/ChatStream";
import type { CloudAgentPublishProgressEvent, CloudAgentPublishStage } from "@shared/types";

type StageState = "pending" | "active" | "done" | "error";
const OPENCRAB_QUESTION_ID = "opencrab-ontology";

const MODES: { id: Mode; label: string; labelEn: string; desc: string; descEn: string; icon: typeof IconBuilding }[] = [
  { id: "single", label: "단일 에이전트", labelEn: "Single agent", desc: "혼자 일하는 에이전트 하나 — 기억·기술·스스로 개선", descEn: "A single agent that works on its own — memory, skills, self-improvement", icon: IconWand },
  { id: "team", label: "멀티 에이전트 팀", labelEn: "Multi-agent team", desc: "여러 역할이 함께 일하는 에이전트 팀 (기획·실행·검수)", descEn: "A team of agents that plan, run, and review together", icon: IconUsers },
  { id: "package", label: "기존 에이전트 패키징", labelEn: "Package existing agent", desc: "외부/로컬 에이전트를 Agentlas 아키텍처로 변환·복구", descEn: "Convert/repair an external or local agent into Agentlas", icon: IconBuilding },
];

// 빌드 첫 진입 빈 화면을 없애는 스타터(value-first). 클릭하면 요청 입력을 채운다.
const STARTERS: { ko: string; en: string; promptKo: string; promptEn: string }[] = [
  {
    ko: "인스타 마케팅 운영팀",
    en: "Instagram marketing team",
    promptKo: "인스타그램 마케팅을 운영하는 에이전트 팀 — 콘텐츠 기획, 카피, 해시태그, 게시 일정 관리",
    promptEn: "An agent team that runs Instagram marketing — content planning, copy, hashtags, and publishing schedules",
  },
  {
    ko: "경리 자동화 에이전트",
    en: "Bookkeeping automation agent",
    promptKo: "영수증·세금계산서를 분류하고 월 정산표를 만드는 경리 자동화 에이전트",
    promptEn: "A bookkeeping automation agent that classifies receipts and invoices, then prepares a monthly reconciliation sheet",
  },
  {
    ko: "리서치 애널리스트",
    en: "Research analyst",
    promptKo: "주제를 받아 출처를 모으고 사실검증한 뒤 요약 리포트를 쓰는 리서치 애널리스트 에이전트",
    promptEn: "A research analyst agent that gathers sources for a topic, verifies the facts, and writes a concise report",
  },
];

// 사용자에게 보이는 실제 순서 — 요구사항을 먼저 확인한 뒤 엔진/MCP를 준비하고,
// 그 다음에만 에이전트가 조사·생성·검증·배포를 수행한다.
const STAGES: { key: string; label: string; labelEn: string; sub: string; subEn: string; icon: typeof IconRoute; color: string }[] = [
  { key: "brief", label: "요구사항 확인", labelEn: "Confirm brief", sub: "완료 기준 · 입력 · 사용 맥락 · 권한", subEn: "outcome · inputs · context · authority", icon: IconRoute, color: "var(--info)" },
  { key: "setup", label: "엔진·MCP 준비", labelEn: "Engine & MCP", sub: "모델 선택 · 연결 범위 확인", subEn: "model choice · connection review", icon: IconRoute, color: "var(--info)" },
  { key: "research", label: "리서치·설계", labelEn: "Research & plan", sub: "요구사항 기반 조사 · 패키지 설계", subEn: "brief-led research · package plan", icon: IconSearch, color: "var(--info)" },
  { key: "generate", label: "패키지 생성", labelEn: "Generate package", sub: "설치할 수 있는 패키지 파일을 만들어요", subEn: "Creates the installable package files", icon: IconWand, color: "var(--purple-deep)" },
  { key: "verify", label: "검증", labelEn: "Verify", sub: "보안·무결성 자동 검사", subEn: "automatic security & integrity checks", icon: IconShield, color: "var(--ok)" },
  { key: "deliver", label: "배포", labelEn: "Deliver", sub: "내 라이브러리에 설치 · 클라우드에 올리기", subEn: "install to my library · upload to the cloud", icon: IconStore, color: "var(--warn)" },
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
  const directIds = new Set([runtime.kind, runtime.source]);
  const direct = usage.providers.find((provider) => directIds.has(provider.provider));
  if (direct) return direct;
  return usage.providers.find((provider) => provider.backend === runtime.backend) ?? null;
}

function runtimeUsageBlocked(runtime: RuntimeStatus, usage: UsageSnapshot | null): boolean {
  const provider = runtimeUsageProvider(runtime, usage);
  if (!provider) return false;
  if (provider.status === "error" && provider.error && BUILD_BLOCKING_USAGE_ERRORS.has(provider.error)) return true;
  return provider.status === "ok" && provider.windows.some((window) => window.usedPercent >= 100);
}

function fmtLogTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildLocalBillingLabel(ko: boolean): string {
  return ko ? "빌드 0크레딧" : "Build 0 credits";
}

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
    receipt: ["저장 영수증 확인 중", "Verifying the save receipt"],
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
  if (lower.includes("quota") || lower.includes("credit")) {
    return ko
      ? "크레딧 또는 사용량 한도 때문에 멈췄습니다. 계정/크레딧 상태를 확인하세요."
      : "Upload stopped because of credits or quota. Check account and credit status.";
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

export default function BuildPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [folderMsg, setFolderMsg] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({});
  const [cloudChoiceError, setCloudChoiceError] = useState<string | null>(null);
  const [cloudUploadProgress, setCloudUploadProgress] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const cloudUploadInFlightRef = useRef<string | null>(null);
  const cloudUploadProgressIdRef = useRef<string | null>(null);

  // 모듈 레벨 빌드 스토어 구독 — 다른 메뉴로 이동했다 돌아와도 진행 상태(로그·단계·결과·인터뷰)가 유지된다.
  const s = useSyncExternalStore(buildSubscribe, getBuildSnapshot, getBuildSnapshot);

  // 앱을 다시 켜거나 새로고침해도 Main에서 돌고 있는 빌드에 다시 붙는다.
  // (메뉴 이동은 모듈 스토어가 이미 지키므로 여기 대상이 아니다.)
  useEffect(() => { void reattachRunningBuild(); }, []);
  const { request, mode, workspace, workspaceGrant, runtime, phase, log, reached, errored, recoverable, error: buildError, result, registered, registeredEntity, pendingQuestions, pendingAllocation, awaitingReply, turn, attachments, mcpPlan, mcpReceipt, cloudSaveChoice, liveness } = s;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyOneReviewSeed = useCallback((seed: OneSuggestionReviewSeed): OneReviewSeedApplyResult => {
    if (seed.kind !== "agent_build" || seed.targetSurface !== "build" || seed.buildMode !== "single") return "blocked";
    if (status === null) return "defer";
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
    return "applied";
  }, [ko, status]);

  // 드롭/파일 인풋 → 실제 디스크 경로(webUtils) → 스토어 첨부. 경로를 못 얻으면(브라우저 등) 스킵.
  const addDroppedFiles = async (files: FileList) => {
    const items: BuildAttachment[] = [];
    for (const f of Array.from(files)) {
      const grant = await grantForDroppedFile(f);
      if (!grant) continue;
      const p = grant.path;
      items.push({ path: p, grant, name: f.name || p.split("/").pop() || p, kind: grant.kind === "directory" ? "dir" : "file" });
    }
    if (items.length > 0) addAttachments(items);
  };

  const attachFolder = async () => {
    const dir = await ipc()?.fs.pickDirectory();
    if (dir) addAttachments([{ path: dir.path, grant: dir, name: dir.path.split("/").pop() || dir.path, kind: "dir" }]);
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
    const api = ipc();
    if (!api) {
      setFolderMsg(ko ? "폴더 선택을 사용할 수 없습니다." : "Folder picker is not available.");
      return;
    }
    setFolderMsg(ko ? "폴더 선택 창을 여는 중..." : "Opening folder picker...");
    try {
      const dir = await api.fs.pickDirectory();
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
    const api = ipc();
    if (!api) return;
    setFolderMsg(ko ? "생성 폴더 권한을 다시 요청하는 중..." : "Requesting output-folder access again...");
    try {
      const dir = await api.fs.pickDirectory();
      if (!dir) {
        setFolderMsg(ko ? "폴더 다시 선택을 취소했습니다." : "Folder re-selection was cancelled.");
        return;
      }
      setBuildWorkspace(dir);
      resetBuild();
      setFolderMsg(ko ? "폴더 권한을 갱신했습니다. 요청과 설정은 유지됐습니다. 다시 시작을 눌러 확인하세요." : "Folder access was refreshed. Your request and settings were kept. Start again when ready.");
    } catch {
      setFolderMsg(ko ? "폴더 권한을 갱신하지 못했습니다. Finder에서 폴더가 실제로 있는지 확인하세요." : "Could not refresh folder access. Check that the folder still exists in Finder.");
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
    if (!key) {
      setBuildRuntime(null);
      return;
    }
    // key 형식: "<kind>:<source>" 또는 "<kind>:<source>::<modelId>"
    const [runtimeKeyPart, modelId] = key.split("::");
    const r = runtimes.find((x) => `${x.kind}:${x.source}` === runtimeKeyPart);
    setBuildRuntime(r
      ? { kind: r.kind, backend: r.backend, source: r.source, model: modelId || r.model || undefined }
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
      const res = await ipc()?.hephaestus.publish({ folder: target, scope, visibility: "marketplace" });
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
              ? "Agent Cloud 저장은 완료됐지만 이 컴퓨터의 동기화 영수증을 저장하지 못했습니다. 수정 전 Cloud 최신본을 복원하세요."
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
    setActionMsg(ko ? "이 컴퓨터에만 저장했습니다. 네트워크 요청은 보내지 않았습니다." : "Kept on this computer only. No network request was sent.");
  };

  const engineMissing = status ? !status.available : false;
  const selectedRuntimeStatus = runtime
    ? runtimes.find((item) => runtimeKey(item) === runtimeKey(runtime)) ?? null
    : runtimes.find((item) => item.active) ?? runtimes[0] ?? null;
  const selectedRuntimeProviderLabel = selectedRuntimeStatus
    ? runtimeUsageProvider(selectedRuntimeStatus, usage)?.label ?? engineLabel(selectedRuntimeStatus, ko)
    : null;
  const selectedRuntimeBlocked = selectedRuntimeStatus ? runtimeUsageBlocked(selectedRuntimeStatus, usage) : false;
  const running = phase === "running";
  // 대화형 빌드가 진행 중(엔진 실행 중이거나 인터뷰 답변 대기 중)이면 컴포저 입력을 잠근다.
  const busy = phase === "running" || phase === "mcp-review" || phase === "runtime-approval" || phase === "interview";
  const startBlocker = !request.trim()
    ? (ko ? "요청을 먼저 입력하세요." : "Enter a request first.")
    : !workspace
      ? (ko ? "생성 폴더를 선택하세요." : "Choose an output folder.")
      : engineMissing
        ? (ko ? "Hephaestus 엔진을 사용할 수 없습니다." : "Hephaestus engine is unavailable.")
        : selectedRuntimeBlocked
          ? (ko ? "선택된 AI 엔진의 사용량이 소진됐습니다. 위에서 사용 가능한 다른 엔진을 선택하세요." : "The selected AI engine has no usage remaining. Choose another available engine above.")
        : null;
  // 파이프라인은 항상 표시 — idle 에선 딤된 프리뷰로 무엇을 할지 보여준다.
  const showPipeline = true;
  const resultScanDisposition = result ? buildScanDisposition(result.securityScan) : "unverified";
  const resultHasSecurityAdvisory = resultScanDisposition !== "passed";

  return (
    <div className="rd build-root">
      <div className="titlebar-drag build-window-drag" />
      <main className="build-scroll">
        <div className="build-shell">
          <header className="build-header">
            <div className="build-title-group">
              <Link href="/apps" className="titlebar-nodrag build-back-link">
                <IconChevronRight size={14} />
                Apps
              </Link>
              <div className="build-title-mark"><IconBuilding size={18} /></div>
              <div>
                <h1>{ko ? "빌드" : "Build"}</h1>
                <div className="build-subtitle">{ko ? "에이전트 제작 도우미" : "Agent creation assistant"}</div>
              </div>
            </div>
            <div className="build-header-status titlebar-nodrag">
              <KeyStatusBanner
                mode="pill"
                relevantProvider={selectedRuntimeProviderLabel}
                problemsInBanner
              />
            </div>
          </header>

          <KeyStatusBanner mode="banner" relevantProvider={selectedRuntimeProviderLabel} />

          {/* Ambient status layer — pinned so it is on screen no matter how far
              the log has scrolled. This is the one element that must never go
              quiet: the pipeline card scrolls away, and the Build Log genuinely
              has nothing to print while a runtime reasons for minutes. */}
          {busy && (
            <div className="build-livebar" role="status" aria-live="polite">
              <span className="forge-pulse" />
              <strong className="build-livebar-stage">
                {phase === "interview"
                  ? ko ? "빌드 요구사항 — 답변 대기" : "Build brief — awaiting your answer"
                  : phase === "mcp-review"
                    ? ko ? "MCP 연결 계획 확인" : "Confirm the MCP plan"
                    : phase === "runtime-approval"
                      ? ko ? "빌드 모델 선택" : "Choose the build model"
                    : ko
                      ? STAGES[Math.min(reached, STAGES.length - 1)].label
                      : STAGES[Math.min(reached, STAGES.length - 1)].labelEn}
              </strong>
              <span className="build-livebar-activity" title={liveness?.activity || undefined}>
                {/* While the build is waiting on the PERSON, the engine is idle
                    by design. Reporting engine activity there would describe
                    work that is not happening. */}
                {phase === "interview"
                  ? ko ? "당신 차례입니다 — 아래 질문에 답해 주세요" : "Your turn — answer the questions below"
                  : phase === "mcp-review"
                    ? ko ? "당신 차례입니다 — MCP 선택을 확인하세요" : "Your turn — confirm the MCP selection"
                    : phase === "runtime-approval"
                      ? ko ? "당신 차례입니다 — 모델을 선택하세요" : "Your turn — choose the model"
                    : liveness?.activity || (ko ? "엔진 준비 중" : "Preparing the engine")}
              </span>
              <span className="build-livebar-time"><ElapsedClock startedAt={stageStartedAt} /></span>
              {phase === "running" && liveness && liveness.silentMs >= 45_000 && (
                <span className="build-livebar-silent">
                  {ko
                    ? "시간이 더 필요한 단계 · 계속 작업 중"
                    : "Longer step · still working"}
                </span>
              )}
            </div>
          )}

          <Suspense fallback={null}>
            <OneSuggestionReviewHandoffBanner surface="build" locale={locale} onReviewSeed={applyOneReviewSeed} />
          </Suspense>

          {engineMissing && (
            <div className="build-alert">
              <IconShield size={15} />
              <div className="key-status-banner-copy">
                <strong>
                  {ko ? "Hephaestus 엔진을 사용할 수 없습니다" : "Hephaestus engine unavailable"}
                  {status?.reason ? `: ${status.reason}` : ""}
                </strong>
                <span>
                  {ko
                    ? "엔진은 앱에 번들된 오픈소스입니다. 앱 내부 복구를 다시 시도하거나 Python 런타임을 확인하세요 (npm run ensure:engine)."
                    : "The engine ships bundled with the app. Retry the in-app repair or check the Python runtime (npm run ensure:engine)."}
                </span>
              </div>
            </div>
          )}

          <section className="build-grid">
            <div className="build-card build-composer" data-tour-id="build.request">
              <div className="build-card-head">
                <span>{ko ? "요청" : "Request"}</span>
                <span>{mode || "auto"}</span>
              </div>

              <div className="build-mode-grid">
                {MODES.map((m) => {
                  const active = mode === m.id;
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setBuildMode(active ? "" : m.id)}
                      disabled={busy}
                      className="build-mode-card titlebar-nodrag"
                      data-active={active ? "true" : "false"}
                      data-mode={m.id}
                      aria-pressed={active}
                    >
                      <span className="build-mode-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <strong>{ko ? m.label : m.labelEn}</strong>
                      <span className="build-mode-desc">{ko ? m.desc : m.descEn}</span>
                      <span className="build-mode-price">{buildLocalBillingLabel(ko)}</span>
                      <span className="build-mode-check" aria-hidden="true">
                        <IconCheck size={12} />
                      </span>
                    </button>
                  );
                })}
              </div>

              {!busy && (
                <div className="build-starters">
                  <span className="build-starters-label">{ko ? "스타터" : "Starters"}</span>
                  {STARTERS.map((s) => (
                    <button
                      key={s.en}
                      type="button"
                      className="build-starter-chip titlebar-nodrag"
                      onClick={() => setBuildRequest(ko ? s.promptKo : s.promptEn)}
                    >
                      {ko ? s.ko : s.en}
                    </button>
                  ))}
                </div>
              )}

              <div
                className="build-request-drop"
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (busy) return;
                  addDroppedFiles(e.dataTransfer.files);
                }}
              >
                <textarea
                  value={request}
                  onChange={(e) => setBuildRequest(e.target.value)}
                  disabled={busy}
                  placeholder={ko ? "무엇을 시킬까요? 예) 인스타그램 마케팅 운영 에이전트 — 참고할 파일·폴더는 아래 첨부나 드래그로" : "What should it do? e.g. an Instagram marketing agent — drop reference files/folders below"}
                  rows={5}
                  className="build-request-input titlebar-nodrag"
                />
                <div className="build-attach-row">
                  <button type="button" className="build-attach-button titlebar-nodrag" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                    📎 {ko ? "파일 첨부" : "Attach files"}
                  </button>
                  <button type="button" className="build-attach-button titlebar-nodrag" disabled={busy} onClick={() => void attachFolder()}>
                    <IconFolder size={12} /> {ko ? "폴더 첨부" : "Attach folder"}
                  </button>
                  <span className="build-attach-hint">
                    {ko ? "기존 에이전트·스킬 폴더, 이미지, 문서 등 — 빌더가 읽고 반영합니다" : "Existing agent/skill folders, images, docs — the builder reads them"}
                  </span>
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
                </div>
                {attachments.length > 0 && (
                  <div className="build-attach-chips">
                    {attachments.map((a, i) => (
                      <span key={a.path} className="build-attach-chip" title={a.path}>
                        {a.kind === "dir" ? <IconFolder size={11} /> : <span className="build-artifact-filedot" />}
                        <span className="build-attach-chip-name">{a.name}</span>
                        {!busy && (
                          <button type="button" className="build-attach-chip-x titlebar-nodrag" aria-label={ko ? "첨부 제거" : "Remove attachment"} onClick={() => removeAttachment(i)}>
                            ✕
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="build-model-row">
                <label className="build-model-label" htmlFor="build-model-select">
                  {ko ? "빌드 모델" : "Build model"}
                </label>
                <select
                  id="build-model-select"
                  className="build-model-select titlebar-nodrag"
                  value={runtimeKey(runtime)}
                  onChange={(e) => onSelectRuntime(e.target.value)}
                  disabled={busy}
                >
                  <option value="">{ko ? "자동 선택 (활성 엔진)" : "Auto (active engine)"}</option>
                  {runtimes.flatMap((r) => {
                    const key = `${r.kind}:${r.source}`;
                    const blocked = runtimeUsageBlocked(r, usage);
                    const suffix = `${r.active ? (ko ? " · 활성" : " · active") : ""}${blocked ? (ko ? " · 사용량 소진" : " · usage exhausted") : ""}`;
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
                    return models.map((m) => (
                      <option key={`${key}::${m.id}`} value={`${key}::${m.id}`} disabled={blocked}>
                        {engineLabel(r, ko)} · {m.label}{suffix}
                      </option>
                    ));
                  })}
                </select>
              </div>

              <div className="build-action-row" data-tour-id="build.interview">
                <button onClick={pickWorkspace} disabled={busy} className="build-folder-button titlebar-nodrag">
                  <IconFolder size={15} />
                  <span>{workspace ? workspace.split("/").slice(-2).join("/") : ko ? "생성 폴더 선택" : "Choose output folder"}</span>
                </button>
                {running ? (
                  <button onClick={cancelBuild} className="build-secondary-button titlebar-nodrag">{ko ? "중지" : "Stop"}</button>
                ) : phase === "mcp-review" ? (
                  <button onClick={cancelBuild} className="build-secondary-button titlebar-nodrag">{ko ? "MCP 검토 취소" : "Cancel MCP review"}</button>
                ) : phase === "runtime-approval" ? (
                  <button onClick={cancelBuild} className="build-secondary-button titlebar-nodrag">{ko ? "모델 선택 취소" : "Cancel model review"}</button>
                ) : phase === "interview" ? (
                  <button onClick={resetBuild} className="build-secondary-button titlebar-nodrag">{ko ? "인터뷰 취소" : "Cancel interview"}</button>
                ) : phase === "error" && recoverable && buildError?.kind !== "workspace-unavailable" ? (
                  <>
                    <button onClick={() => void resumeBuild()} className="build-primary-button titlebar-nodrag">
                      {ko ? "보존된 파일에서 이어서 빌드" : "Resume from saved files"}
                    </button>
                    <button onClick={startFreshBuild} className="build-secondary-button titlebar-nodrag">
                      {ko ? "새 빌드" : "New build"}
                    </button>
                  </>
                ) : phase === "done" || phase === "error" ? (
                  <button onClick={startFreshBuild} className="build-secondary-button titlebar-nodrag">{ko ? "새 빌드" : "New build"}</button>
                ) : (
                  <button
                    onClick={() => {
                      const active = runtimes.find((item) => item.active) ?? runtimes[0];
                      void startBuild(active ? { kind: active.kind, backend: active.backend, source: active.source, model: active.model ?? undefined, longContext: active.longContextEnabled, effort: active.effort ?? undefined } : undefined);
                    }}
                    disabled={Boolean(startBlocker)}
                    className="build-primary-button titlebar-nodrag"
                  >
                    <IconWand size={15} /> {ko ? "딥인터뷰로 빌드 시작" : "Start build (deep interview)"}
                  </button>
                )}
              </div>
              {(startBlocker || folderMsg) && !running && phase !== "interview" && (
                <div role="status" className="build-inline-hint">
                  {startBlocker || folderMsg}
                </div>
              )}
              <p className="build-autoadd-hint">
                {ko
                  ? "데스크톱 Build 자체는 Agentlas 크레딧 0입니다. 이 컴퓨터의 Claude Code/Codex/Antigravity/BYOK/Ollama로 실행되며, Hub Network 호출은 별도 견적/확인 후 크레딧을 씁니다."
                  : "Desktop Build itself costs 0 Agentlas credits. It runs on this computer through Claude Code/Codex/Antigravity/BYOK/Ollama; Hub Network calls spend credits separately after quote and confirmation."}
              </p>
            </div>

            {showPipeline && (
              <div className="build-card build-pipeline-card" data-tour-id="build.pipeline">
                <div className="build-card-head">
                  <span>{ko ? "파이프라인" : "Pipeline"}</span>
                  {running ? (
                    <span className="build-live">
                      <span className="forge-pulse" />
                      {ko ? STAGES[Math.min(reached, STAGES.length - 1)].label : STAGES[Math.min(reached, STAGES.length - 1)].labelEn}
                      <em className="build-live-elapsed"><ElapsedClock startedAt={stageStartedAt} /></em>
                    </span>
                  ) : phase === "interview" ? (
                    <span className="build-live">
                      <span className="forge-pulse" />
                      {ko ? "요구사항 확인 중" : "confirming brief"}
                      <em className="build-live-elapsed"><ElapsedClock startedAt={stageStartedAt} /></em>
                    </span>
                  ) : phase === "mcp-review" ? (
                    <span className="build-live">
                      <span className="forge-pulse" />
                      {ko ? "MCP 연결 확인 중" : "confirming MCP"}
                      <em className="build-live-elapsed"><ElapsedClock startedAt={stageStartedAt} /></em>
                    </span>
                  ) : phase === "runtime-approval" ? (
                    <span className="build-live">
                      <span className="forge-pulse" />
                      {ko ? "모델 선택 대기" : "awaiting model choice"}
                      <em className="build-live-elapsed"><ElapsedClock startedAt={stageStartedAt} /></em>
                    </span>
                  ) : (
                    <span>{phase}</span>
                  )}
                </div>
                <div className="build-pipeline-list">
                  {STAGES.map((s, i) => (
                    <StageRow
                      key={s.key}
                      stage={s}
                      state={stageStates[i]}
                      isLast={i === STAGES.length - 1}
                      ko={ko}
                      elapsedStartedAt={stageStates[i] === "active" ? stageStartedAt : undefined}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>

          {phase === "mcp-review" && mcpPlan && (
            <McpBuildInterviewCard
              plan={mcpPlan}
              ko={ko}
              onApprove={(selectedIds) => void approveBuildMcpPlan(selectedIds)}
              onCancel={cancelBuild}
            />
          )}

          {phase === "runtime-approval" && pendingAllocation && (
            <section className="build-card">
              <div className="build-card-head">
                <strong>{ko ? "이 빌드에 더 상위 모델을 쓸까요?" : "Use a higher model for this build?"}</strong>
              </div>
              <p className="build-card-note">
                {ko
                  ? `이 작업이 어렵다고 판단해 ${describeAllocationRuntime(pendingAllocation.allocated)} 사용을 제안합니다. 내가 고른 건 ${describeAllocationRuntime(pendingAllocation.current)}입니다.`
                  : `This work was judged demanding, so ${describeAllocationRuntime(pendingAllocation.allocated)} is proposed. Your own choice is ${describeAllocationRuntime(pendingAllocation.current)}.`}
              </p>
              <p className="build-card-note">
                {ko
                  ? "상위 모델은 결과가 더 좋을 수 있지만 구독·크레딧을 더 씁니다. 어느 쪽을 고르든 이 빌드는 그 모델로 고정됩니다."
                  : "A higher model may produce better results but uses more of your subscription/credits. Either choice is pinned for this build."}
              </p>
              <div className="build-card-actions">
                <button
                  className="build-secondary-button"
                  onClick={() => void resolveRuntimeEscalation(false)}
                >
                  {ko ? `내 선택 유지 (${describeAllocationRuntime(pendingAllocation.current)})` : `Keep my choice (${describeAllocationRuntime(pendingAllocation.current)})`}
                </button>
                <button
                  className="build-primary-button"
                  onClick={() => void resolveRuntimeEscalation(true)}
                >
                  {ko ? `${describeAllocationRuntime(pendingAllocation.allocated)} 사용` : `Use ${describeAllocationRuntime(pendingAllocation.allocated)}`}
                </button>
              </div>
            </section>
          )}

          {phase === "error" && buildError && (
            <section className="build-card" role="alert">
              <div className="build-card-head">
                <strong>{ko ? "빌드가 멈춘 이유" : "Why the build stopped"}</strong>
              </div>
              <p className="build-card-note">{buildError.message}</p>
              <div className="build-card-actions">
                {buildError.kind === "workspace-unavailable" && (
                  <button className="build-primary-button titlebar-nodrag" onClick={() => void reauthorizeWorkspace()}>
                    {ko ? "생성 폴더 다시 선택" : "Choose output folder again"}
                  </button>
                )}
                <button className="build-secondary-button titlebar-nodrag" onClick={resetBuild}>
                  {ko ? "요청 유지하고 다시 준비" : "Keep request and prepare again"}
                </button>
              </div>
            </section>
          )}

          {mcpReceipt && phase !== "mcp-review" && (
            <McpAttachmentReceiptCard receipt={mcpReceipt} ko={ko} />
          )}

          {awaitingReply && pendingQuestions.length > 0 && (
            <section className="build-card build-interview-card">
              <div className="build-card-head build-interview-head">
                <span>{ko ? `빌드 요구사항 · 질문 묶음 ${turn}` : `Build brief · question batch ${turn}`}</span>
                <div className="build-interview-head-actions">
                  <span className="build-live"><span className="forge-pulse" />{ko ? "답변 대기" : "awaiting"}</span>
                </div>
              </div>
              <p className="build-interview-hint">
                {ko
                  ? "필요한 질문을 한 번에 모았습니다. 질문마다 선택하거나 직접 답변을 적은 뒤, 확인을 눌러 한 번에 보냅니다."
                  : "The needed questions are grouped here. Pick options or type an answer under each question, then press Confirm once."}
              </p>
              {pendingQuestions.map((q) => (
                <div key={q.id} className="build-interview-q">
                  <div className="build-interview-qtext">{q.question}</div>
                  <div className="build-interview-opts">
                    {q.options.map((o, index) => {
                      const selected = (selectedOptions[q.id] ?? []).includes(o.label);
                      return (
                        <button
                          key={o.label}
                          type="button"
                          className="build-interview-opt titlebar-nodrag"
                          data-selected={selected ? "true" : "false"}
                          aria-pressed={selected}
                          title={o.description ? `${o.label}: ${o.description}` : o.label}
                          onClick={() => toggleInterviewOption(q.id, o.label)}
                        >
                          <span className="build-interview-opt-index">{index + 1}</span>
                          <span className="build-interview-opt-body">
                            <strong>{o.label}</strong>
                            {o.description && <span>{o.description}</span>}
                          </span>
                          <span className="build-interview-opt-check" aria-hidden="true">
                            <IconCheck size={12} />
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
                    placeholder={ko ? "이 질문에 직접 답변…" : "Type your own answer to this question…"}
                    className="build-interview-input build-interview-qinput titlebar-nodrag"
                  />
                </div>
              ))}
              <div className="build-interview-reply">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) confirmInterviewReply();
                  }}
                  rows={2}
                  placeholder={ko ? "묶음 전체에 대한 추가 메모… (⌘↵ 확인)" : "Extra note for the whole batch… (⌘↵ to confirm)"}
                  className="build-interview-input titlebar-nodrag"
                />
                <button
                  type="button"
                  onClick={confirmInterviewReply}
                  disabled={!composedReply.trim()}
                  className="build-primary-button titlebar-nodrag"
                >
                  {ko ? (selectedCount > 0 ? `선택 ${selectedCount}개 확인` : "확인") : selectedCount > 0 ? `Confirm ${selectedCount}` : "Confirm"}
                </button>
              </div>
            </section>
          )}

          {phase === "done" && result && (
            <section className="build-card build-artifact-card">
              <div className="build-card-head">
                <span>{ko ? "산출물" : "Artifacts"}</span>
                <span>
                  {resultScanDisposition === "passed"
                    ? "ready"
                    : (ko ? "참고 항목 있음" : "advisory findings")}
                </span>
              </div>
              <ArtifactPreview workspace={result.workspace} readScope={result.readScope} ko={ko} />
              <SecurityScanBlock scan={result.securityScan} folder={result.workspace} scope={result.readScope} ko={ko} />
              <div className="build-result-actions">
                <span>
                  <IconCheck size={15} />{" "}
                  {registered
                    ? ko ? "패키지 준비됨 · 조직도에 추가됨" : "Package ready · added to org chart"
                    : ko ? "패키지 준비됨" : "Package ready"}
                </span>
                <button onClick={installToLibrary} className="build-primary-button titlebar-nodrag">
                  {registeredEntity?.kind === "agent"
                    ? ko ? "내 에이전트에서 열기" : "Open in My Agents"
                    : ko ? "조직도에서 열기" : "Open org chart"}
                </button>
              </div>
              <div className="build-upload-choice">
                <div className="build-upload-choice-label">{ko ? "공개 배포는 별도 선택" : "Public distribution is a separate choice"}</div>
                <div className="build-upload-choice-grid build-upload-choice-grid-single">
                  <button onClick={() => void uploadToPublicHub()} className="build-upload-option titlebar-nodrag">
                    <strong>{ko ? "허브 (공개)" : "Hub (public)"}</strong>
                    <span>{ko ? "허브 레지스트리에 공개 후보로 제출" : "Submit to the public Hub registry"}</span>
                  </button>
                </div>
              </div>
              {resultHasSecurityAdvisory && (
                <div role="status" className="build-action-msg">
                  {ko
                    ? "안전 점검 결과는 참고용입니다. 항목과 영수증을 확인할 수 있으며 설치·Cloud 저장·Hub 공개는 계속 진행할 수 있습니다."
                    : "Safety findings are advisory. Findings and receipts remain visible, and install, Cloud save, and Hub publish can continue."}
                </div>
              )}
              {actionMsg && <div className="build-action-msg">{actionMsg}</div>}
            </section>
          )}

          {/* 실행 중과 실패 직후에는 펼쳐 둔다. 접힌 채로 두면 "작업 중"이라는 글자만
              보이고 그 아래가 비어 있어, 아무 일도 안 일어나는 것처럼 읽힌다
              (2026-08-16 오너 제보). 완료된 빌드만 접어 둔다. */}
          {log.length > 0 && (
            <details
              className="build-card build-log-card"
              data-tour-id="build.log"
              open={running || phase === "error"}
            >
              <summary className="build-card-head">
                <span>{ko ? "진행 세부사항" : "Activity details"}</span>
                {running
                  ? <span className="build-live"><span className="forge-pulse" />{ko ? "작업 중" : "working"}</span>
                  : phase === "done" && <span>{ko ? "완료" : "complete"}</span>}
              </summary>
              <div className="build-log-body">
                {log.map((l, i) => (
                  <div key={i} data-kind={l.kind}>
                    <span className="build-log-time">{fmtLogTime(l.at)}</span>
                    <span>{l.text}</span>
                  </div>
                ))}
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
        </div>
      </main>
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

function StageRow({
  stage,
  state,
  isLast,
  ko,
  elapsedStartedAt,
}: {
  stage: (typeof STAGES)[number];
  state: StageState;
  isLast: boolean;
  ko: boolean;
  /** Wall-clock start of this stage. Only meaningful while state === "active". */
  elapsedStartedAt?: number;
}) {
  const Icon = stage.icon;
  const c = stage.color;
  const active = state === "active";
  const done = state === "done";
  const error = state === "error";

  return (
    <div className="build-stage-row" data-state={state} style={{ "--stage-color": c } as CSSProperties}>
      <div className="build-stage-rail">
        <div className="build-stage-node">
          {done ? <IconCheck size={18} /> : <Icon size={18} />}
        </div>
        {!isLast && <div className="build-stage-line" />}
      </div>
      <div className="build-stage-copy">
        <div>
          <span>{ko ? stage.label : stage.labelEn}</span>
          {active && (
            <em>
              {ko ? "진행 중" : "running"}
              {elapsedStartedAt !== undefined && <> · <ElapsedClock startedAt={elapsedStartedAt} /></>}
            </em>
          )}
          {done && <em>{ko ? "완료" : "done"}</em>}
          {error && <em>{ko ? "중단" : "stopped"}</em>}
        </div>
        <p>{ko ? stage.sub : stage.subEn}</p>
      </div>
    </div>
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
      <p className="build-artifact-note">
        {ko ? "이게 진짜 내 디스크에 생긴 파일입니다 — 클라우드가 아니라 내 폴더." : "These are real files on your disk — your folder, not the cloud."}
      </p>
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
    <div>
      <VerifyGate scan={scan} ko={ko} />
      <button
        onClick={() => void rescan()}
        disabled={busy}
        className="titlebar-nodrag"
        style={{
          marginTop: 6,
          padding: "6px 10px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--paper-edge)",
          background: "var(--paper)",
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--ink-soft)",
        }}
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
