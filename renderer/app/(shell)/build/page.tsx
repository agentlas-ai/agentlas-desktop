"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { KeyStatusBanner } from "@/components/KeyStatusBanner";
import type { DirListing, FsReadScope, HephaestusStatus, RuntimeSelection, RuntimeStatus } from "@/lib/types";
import {
  subscribe as buildSubscribe,
  getSnapshot as getBuildSnapshot,
  setRequest as setBuildRequest,
  setMode as setBuildMode,
  setWorkspace as setBuildWorkspace,
  setRuntime as setBuildRuntime,
  startBuild,
  answerBuild,
  cancelBuild,
  resetBuild,
  addAttachments,
  removeAttachment,
  updateBuildSecurityScan,
  type Mode,
  type BuildAttachment,
} from "@/lib/build-session";
import { buildScanDisposition, buildScanFindings, buildScanSeverityBucket } from "@/lib/build-scan";
import type { ChatQuestion } from "@/components/ChatStream";

type StageState = "pending" | "active" | "done" | "error";

const MODES: { id: Mode; label: string; labelEn: string; desc: string; descEn: string; icon: typeof IconBuilding }[] = [
  { id: "single", label: "단일 에이전트", labelEn: "Single agent", desc: "혼자 일하는 에이전트 하나 — 기억·기술·스스로 개선", descEn: "A single agent that works on its own — memory, skills, self-improvement", icon: IconWand },
  { id: "team", label: "멀티 에이전트 팀", labelEn: "Multi-agent team", desc: "여러 역할이 함께 일하는 에이전트 팀 (기획·실행·검수)", descEn: "A team of agents that plan, run, and review together", icon: IconUsers },
  { id: "package", label: "기존 에이전트 패키징", labelEn: "Package existing agent", desc: "외부/로컬 에이전트를 Agentlas 아키텍처로 변환·복구", descEn: "Convert/repair an external or local agent into Agentlas", icon: IconBuilding },
];

// 빌드 첫 진입 빈 화면을 없애는 스타터(value-first). 클릭하면 요청 입력을 채운다.
const STARTERS: { ko: string; en: string; prompt: string }[] = [
  { ko: "인스타 마케팅 운영팀", en: "Instagram marketing team", prompt: "인스타그램 마케팅을 운영하는 에이전트 팀 — 콘텐츠 기획, 카피, 해시태그, 게시 일정 관리" },
  { ko: "경리 자동화 에이전트", en: "Bookkeeping automation agent", prompt: "영수증·세금계산서를 분류하고 월 정산표를 만드는 경리 자동화 에이전트" },
  { ko: "리서치 애널리스트", en: "Research analyst", prompt: "주제를 받아 출처를 모으고 사실검증한 뒤 요약 리포트를 쓰는 리서치 애널리스트 에이전트" },
];

// /hep-build 의 표준 파이프라인 단계 — 빌더 에이전트 규율(모드 분류 → 인터뷰/리서치 게이트 →
// 패키지 생성 → 검증 → 배포)을 시각화한다.
const STAGES: { key: string; label: string; labelEn: string; sub: string; subEn: string; icon: typeof IconRoute; color: string }[] = [
  { key: "classify", label: "모드 분류", labelEn: "Classify", sub: "단일 · 팀 · 패키지 판정", subEn: "single · team · package", icon: IconRoute, color: "#4DABF7" },
  { key: "research", label: "인터뷰 & 리서치", labelEn: "Interview & research", sub: "요구사항 인터뷰 · 공식 소스 조사", subEn: "requirements interview · source research", icon: IconSearch, color: "#9775FA" },
  { key: "generate", label: "패키지 생성", labelEn: "Generate package", sub: "설치할 수 있는 패키지 파일을 만들어요", subEn: "Creates the installable package files", icon: IconWand, color: "#F783AC" },
  { key: "verify", label: "검증", labelEn: "Verify", sub: "보안·무결성 자동 검사", subEn: "automatic security & integrity checks", icon: IconShield, color: "#4DD4AC" },
  { key: "deliver", label: "배포", labelEn: "Deliver", sub: "내 라이브러리에 설치 · 클라우드에 올리기", subEn: "install to my library · upload to the cloud", icon: IconStore, color: "#FFA94D" },
];

function engineLabel(r: RuntimeStatus, ko: boolean): string {
  switch (r.kind) {
    case "claude-code":
      return "Claude";
    case "codex":
      return "Codex (GPT)";
    case "gemini":
      return "Gemini";
    case "ollama":
      return ko ? "Ollama · 로컬" : "Ollama · local";
    default:
      return r.kind;
  }
}

function runtimeKey(sel: RuntimeSelection | null): string {
  return sel ? `${sel.kind}:${sel.source ?? ""}` : "";
}

function fmtLogTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildLocalBillingLabel(ko: boolean): string {
  return ko ? "빌드 0크레딧" : "Build 0 credits";
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
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

export default function BuildPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [folderMsg, setFolderMsg] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string[]>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({});
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // 모듈 레벨 빌드 스토어 구독 — 다른 메뉴로 이동했다 돌아와도 진행 상태(로그·단계·결과·인터뷰)가 유지된다.
  const s = useSyncExternalStore(buildSubscribe, getBuildSnapshot, getBuildSnapshot);
  const { request, mode, workspace, workspaceGrant, runtime, phase, log, reached, errored, result, registered, pendingQuestions, awaitingReply, turn, attachments } = s;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const sendReply = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setReply("");
    void answerBuild(t);
  };

  const toggleInterviewOption = (questionId: string, label: string) => {
    setSelectedOptions((prev) => {
      const current = prev[questionId] ?? [];
      const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
      return { ...prev, [questionId]: next };
    });
  };

  const setQuestionNote = (questionId: string, value: string) => {
    setQuestionNotes((prev) => ({ ...prev, [questionId]: value }));
  };

  const confirmInterviewReply = () => {
    if (!composedReply.trim()) return;
    setSelectedOptions({});
    setQuestionNotes({});
    sendReply(composedReply);
  };

  useEffect(() => {
    ipc()?.hephaestus.status(locale).then(setStatus).catch(() => setStatus(null));
    ipc()?.runtime.detect().then(setRuntimes).catch(() => setRuntimes([]));
  }, [locale]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);
  useEffect(() => {
    setSelectedOptions({});
    setQuestionNotes({});
    setReply("");
  }, [pendingQuestionKey]);

  // 단계 상태 배열 도출.
  const stageStates: StageState[] = useMemo(() => {
    return STAGES.map((_, i) => {
      if (errored && i === Math.min(reached, STAGES.length - 1)) return "error";
      if (i < reached) return "done";
      if (i === reached && phase === "running") return "active";
      if (phase === "done") return "done";
      return "pending";
    });
  }, [reached, phase, errored]);

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

  const onSelectRuntime = (key: string) => {
    if (!key) {
      setBuildRuntime(null);
      return;
    }
    const r = runtimes.find((x) => `${x.kind}:${x.source}` === key);
    setBuildRuntime(r ? { kind: r.kind, backend: r.backend, source: r.source, model: r.model ?? undefined } : null);
  };

  const installToLibrary = async () => {
    const target = result?.workspace ?? workspace;
    const scope = result?.readScope ?? workspaceGrant?.scope;
    if (!target || !scope) return;
    try {
      const imported = await ipc()?.team.importLocalFolder({ path: target, scope });
      if (imported?.id) navigate(`/library/agents?agentId=${imported.id}`);
    } catch (e) {
      setActionMsg((ko ? "설치 실패: " : "Install failed: ") + friendlyHephaestusMessage((e as Error).message, ko));
    }
  };

  const upload = async (visibility: "private-link" | "marketplace") => {
    const target = result?.workspace ?? workspace;
    const scope = result?.readScope ?? workspaceGrant?.scope;
    if (!target || !scope) return;
    setActionMsg(ko ? `업로드 중 (${visibility === "marketplace" ? "Hub public" : "Cloud private"})…` : "Uploading…");
    try {
      const res = await ipc()?.hephaestus.publish({ folder: target, scope, visibility });
      const raw = res?.error ?? res?.stderr ?? "";
      setActionMsg(
        res?.ok
          ? visibility === "marketplace"
            ? (ko ? "Hub 공개 제출 완료. Hub에서 실제 공개·호출 상태를 확인하세요." : "Submitted to the public Hub. Verify its live publish and call status in Hub.")
            : (ko ? "내 Agent Cloud에 비공개 저장했습니다." : "Saved privately to your Agent Cloud.")
          : (ko ? "업로드 실패. 파일은 그대로입니다: " : "Upload failed. Files were not changed: ") + friendlyHephaestusMessage(raw, ko),
      );
    } catch (err) {
      setActionMsg((ko ? "업로드를 시작하지 못했습니다. 파일은 그대로입니다: " : "Upload could not start. Files were not changed: ") + friendlyHephaestusMessage(String(err), ko));
    }
  };

  const engineMissing = status ? !status.available : false;
  const running = phase === "running";
  // 대화형 빌드가 진행 중(엔진 실행 중이거나 인터뷰 답변 대기 중)이면 컴포저 입력을 잠근다.
  const busy = phase === "running" || phase === "interview";
  const startBlocker = !request.trim()
    ? (ko ? "요청을 먼저 입력하세요." : "Enter a request first.")
    : !workspace
      ? (ko ? "생성 폴더를 선택하세요." : "Choose an output folder.")
      : engineMissing
        ? (ko ? "Hephaestus 엔진을 사용할 수 없습니다." : "Hephaestus engine is unavailable.")
        : null;
  // 파이프라인은 항상 표시 — idle 에선 딤된 프리뷰로 무엇을 할지 보여준다.
  const showPipeline = true;
  const resultScanDisposition = result ? buildScanDisposition(result.securityScan) : "unverified";
  const resultDeliveryBlocked = resultScanDisposition === "blocked" || resultScanDisposition === "unverified";

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
                <div className="build-subtitle">hep-build</div>
              </div>
            </div>
            <div className="build-header-status titlebar-nodrag">
              <KeyStatusBanner mode="pill" />
            </div>
          </header>

          <KeyStatusBanner mode="banner" />

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
                    ? "엔진은 앱에 번들된 오픈소스입니다. 복구하려면 앱을 재설치하거나 Python 런타임을 확인하세요 (npm run ensure:engine)."
                    : "The engine ships bundled with the app. To recover, reinstall the app or check the Python runtime (npm run ensure:engine)."}
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
                      key={s.prompt}
                      type="button"
                      className="build-starter-chip titlebar-nodrag"
                      onClick={() => setBuildRequest(s.prompt)}
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
                  {runtimes.map((r) => (
                    <option key={`${r.kind}:${r.source}`} value={`${r.kind}:${r.source}`}>
                      {engineLabel(r, ko)}
                      {r.model ? ` · ${r.model}` : ""}
                      {r.active ? (ko ? " · 활성" : " · active") : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="build-action-row" data-tour-id="build.interview">
                <button onClick={pickWorkspace} disabled={busy} className="build-folder-button titlebar-nodrag">
                  <IconFolder size={15} />
                  <span>{workspace ? workspace.split("/").slice(-2).join("/") : ko ? "생성 폴더 선택" : "Choose output folder"}</span>
                </button>
                {running ? (
                  <button onClick={cancelBuild} className="build-secondary-button titlebar-nodrag">{ko ? "중지" : "Stop"}</button>
                ) : phase === "interview" ? (
                  <button onClick={resetBuild} className="build-secondary-button titlebar-nodrag">{ko ? "인터뷰 취소" : "Cancel interview"}</button>
                ) : phase === "done" || phase === "error" ? (
                  <button onClick={resetBuild} className="build-secondary-button titlebar-nodrag">{ko ? "새 빌드" : "New build"}</button>
                ) : (
                  <button
                    onClick={() => void startBuild()}
                    disabled={Boolean(startBlocker)}
                    className="build-primary-button titlebar-nodrag"
                  >
                    <IconWand size={15} /> {ko ? "딥인터뷰로 빌드 시작" : "Start build (deep interview)"}
                  </button>
                )}
              </div>
              {(folderMsg || startBlocker) && !running && phase !== "interview" && (
                <div role="status" className="build-inline-hint">
                  {folderMsg || startBlocker}
                </div>
              )}
              <p className="build-autoadd-hint">
                {ko
                  ? "데스크톱 Build 자체는 Agentlas 크레딧 0입니다. 이 Mac의 Claude Code/Codex/Gemini/BYOK/Ollama로 실행되며, Hub Network 호출은 별도 견적/확인 후 크레딧을 씁니다."
                  : "Desktop Build itself costs 0 Agentlas credits. It runs on this Mac through Claude Code/Codex/Gemini/BYOK/Ollama; Hub Network calls spend credits separately after quote and confirmation."}
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
                    </span>
                  ) : phase === "interview" ? (
                    <span className="build-live">
                      <span className="forge-pulse" />
                      {ko ? "딥인터뷰 진행 중" : "deep interview"}
                    </span>
                  ) : (
                    <span>{phase}</span>
                  )}
                </div>
                <div className="build-pipeline-list">
                  {STAGES.map((s, i) => (
                    <StageRow key={s.key} stage={s} state={stageStates[i]} isLast={i === STAGES.length - 1} ko={ko} />
                  ))}
                </div>
              </div>
            )}
          </section>

          {awaitingReply && pendingQuestions.length > 0 && (
            <section className="build-card build-interview-card">
              <div className="build-card-head build-interview-head">
                <span>{ko ? `딥인터뷰 · 질문 묶음 ${turn}` : `Deep interview · question batch ${turn}`}</span>
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
                    : resultScanDisposition === "warning"
                      ? (ko ? "검토" : "review")
                      : (ko ? "검증 필요" : "verification required")}
                </span>
              </div>
              <ArtifactPreview workspace={result.workspace} readScope={result.readScope} ko={ko} />
              <SecurityScanBlock scan={result.securityScan} folder={result.workspace} scope={result.readScope} ko={ko} />
              <div className="build-result-actions">
                <span>
                  <IconCheck size={15} />{" "}
                  {registered
                    ? ko ? "패키지 준비됨 · 조직도에 추가됨" : "Package ready · added to org chart"
                    : resultDeliveryBlocked
                      ? ko ? "패키지 생성됨 · 검증 필요" : "Package created · verification required"
                      : ko ? "패키지 준비됨" : "Package ready"}
                </span>
                <button disabled={resultDeliveryBlocked} onClick={installToLibrary} className="build-primary-button titlebar-nodrag">{ko ? "조직도에서 열기" : "Open in org chart"}</button>
              </div>
              <div className="build-upload-choice">
                <div className="build-upload-choice-label">{ko ? "어디에 올릴까요?" : "Where to upload?"}</div>
                <div className="build-upload-choice-grid">
                  <button disabled={resultDeliveryBlocked} onClick={() => upload("private-link")} className="build-upload-option titlebar-nodrag">
                    <strong>{ko ? "내 클라우드 (비공개)" : "My Cloud (private)"}</strong>
                    <span>{ko ? "내 계정에만 저장 · 공개 Hub와 분리" : "Owner-only storage · separate from the public Hub"}</span>
                  </button>
                  <button disabled={resultDeliveryBlocked} onClick={() => upload("marketplace")} className="build-upload-option titlebar-nodrag">
                    <strong>{ko ? "허브 (공개)" : "Hub (public)"}</strong>
                    <span>{ko ? "허브 레지스트리에 공개 후보로 제출" : "Submit to the public Hub registry"}</span>
                  </button>
                </div>
              </div>
              {resultDeliveryBlocked && (
                <div role="alert" className="build-action-msg">
                  {ko
                    ? "보안 검증이 확인되기 전에는 설치·Cloud 저장·Hub 공개를 진행할 수 없습니다. 재스캔으로 확인하세요."
                    : "Install, Cloud save, and Hub publish stay disabled until the security scan is verified. Re-run the scan to continue."}
                </div>
              )}
              {actionMsg && <div className="build-action-msg">{actionMsg}</div>}
            </section>
          )}

          {log.length > 0 && (
            <section className="build-card build-log-card" data-tour-id="build.log">
              <div className="build-card-head">
                <span>Build Log</span>
                {running ? <span className="build-live"><span className="forge-pulse" />live</span> : phase === "done" && <span>ready</span>}
              </div>
              <div className="build-log-body">
                {log.map((l, i) => (
                  <div key={i} data-kind={l.kind}>
                    <span className="build-log-time">{fmtLogTime(l.at)}</span>
                    {l.kind === "stage" ? `> ${l.text}` : l.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </section>
          )}
        </div>
      </main>
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
}: {
  stage: (typeof STAGES)[number];
  state: StageState;
  isLast: boolean;
  ko: boolean;
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
          {active && <em>{ko ? "진행 중" : "running"}</em>}
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

// ── 검증 게이트 — 엔진의 실제 보안 스캔 결과(done.result.securityScan)를 비개발자 어휘로 표시. ──
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

/** 검증 게이트 + 수동 재스캔 — 빌드 결과의 정적 보안 스캔을 사용자가 원할 때 다시 돌린다.
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
        <strong>{ko ? "안전 점검 (검증 게이트)" : "Safety check (verify gate)"}</strong>
      </div>
      {p.unknown ? (
        <p className="build-verify-note">
          {ko
            ? "보안 검증이 확인되지 않아 설치·Cloud 저장·Hub 공개가 잠겨 있습니다. 재스캔하거나 패키지를 수정해 다시 확인하세요."
            : "Security verification is unavailable, so install, Cloud save, and Hub publish are locked. Re-scan or fix the package and verify again."}
        </p>
      ) : p.items.length === 0 ? (
        <p className="build-verify-note">{ko ? "정적 보안 스캔 통과 — 차단·주의 항목 없음." : "Static security scan passed — no blockers or warnings."}</p>
      ) : (
        <>
          <p className="build-verify-summary">
            {ko ? "통과" : "pass"} {p.pass} · {ko ? "주의" : "warn"} {p.warn}
            {p.blocker > 0 ? ` · ${ko ? "차단" : "block"} ${p.blocker}` : ""}
          </p>
          {p.items.slice(0, 5).map((f, i) => (
            <div key={i} className="build-verify-item" data-sev={f.severity}>
              <span className="build-verify-sev">{f.severity}</span> {f.message}
              {f.file ? ` (${f.file})` : ""}
            </div>
          ))}
          <p className="build-verify-note">{ko ? "차단 항목이 없을 때만 사용자가 직접 설치·저장·공개할 수 있습니다 — 자동 게시 없음." : "Only packages without blocking findings can be installed, saved, or published by an explicit user action — no auto-publish."}</p>
        </>
      )}
    </div>
  );
}
