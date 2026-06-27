"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import {
  IconBuilding,
  IconChevronRight,
  IconUsers,
  IconWand,
  IconFolder,
  IconBolt,
  IconRoute,
  IconSearch,
  IconShield,
  IconStore,
  IconCheck,
} from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useT } from "@/lib/i18n";
import { KeyStatusBanner } from "@/components/KeyStatusBanner";
import { MARGIN_LINE_KO, MARGIN_LINE_EN } from "@/lib/receipts";
import type { DirListing, HephaestusBuildEvent, HephaestusStatus } from "@/lib/types";

type Mode = "single" | "team" | "package";
type Phase = "idle" | "running" | "done" | "error";
type StageState = "pending" | "active" | "done" | "error";

interface LogLine {
  kind: HephaestusBuildEvent["kind"];
  text: string;
}

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

// 파이프라인 단계 매핑 — 엔진이 emit하는 "실제 신호"에 1:1로 묶는다(가짜 추정 금지).
// 엔진(electron/hephaestus/builder.ts)이 보내는 실제 stage:
//   · stage:"build"  → 빌더 시작(분류 완료, 인터뷰/리서치 진입) → index 1
//   · stage:<도구명> (write/edit/create 등 파일 쓰기) → 패키지 생성 → index 2
//   · stage:"security" → 정적 보안 스캔 = 검증 → index 3
//   · done → 전부 완료(배포 가능) → index 5(=STAGES.length)
// 그 외 partial/log 는 LLM 가동 신호이므로 최소 인터뷰/리서치(index 1)로만 본다.
const WRITE_SIGNALS = /write|edit|create|touch|mkdir|apply_patch|str_replace|\.md|agentlas\.json|\.agentlas|파일|생성|scaffold/i;
function stageFromEvent(ev: HephaestusBuildEvent, current: number): number {
  if (ev.kind === "done") return STAGES.length; // 전부 완료
  // 엔진의 명시적 stage 필드를 최우선으로 본다(계약 기반).
  if (ev.kind === "stage") {
    if (ev.stage === "security") return Math.max(current, 3); // 검증
    if (ev.stage === "build") return Math.max(current, 1); // 빌더 시작 = 인터뷰/리서치
    // tool 이름이 파일 쓰기면 생성 단계.
    if (WRITE_SIGNALS.test(`${ev.stage ?? ""} ${ev.text ?? ""}`)) return Math.max(current, 2);
    return Math.max(current, 1);
  }
  if (ev.kind === "partial" || ev.kind === "log") return Math.max(current, 1);
  return current;
}

export default function BuildPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [status, setStatus] = useState<HephaestusStatus | null>(null);
  const [request, setRequest] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<LogLine[]>([]);
  const [reached, setReached] = useState(0); // 도달한 최대 단계(0..STAGES.length)
  const [errored, setErrored] = useState(false);
  // 빌드 done 시 엔진이 첨부하는 실제 결과(생성 폴더 + 보안 스캔). 산출물 미리보기/검증 게이트가 소비.
  const [result, setResult] = useState<{ workspace: string; securityScan: unknown } | null>(null);
  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<null | (() => void)>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ipc()?.hephaestus.status().then(setStatus).catch(() => setStatus(null));
    return () => unsubRef.current?.();
  }, []);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

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
    const dir = await ipc()?.fs.pickDirectory();
    if (dir) setWorkspace(dir);
  };

  const start = async () => {
    const api = ipc();
    const ev = ipcEvents();
    if (!api || !ev || !request.trim() || !workspace || phase === "running") return;
    setPhase("running");
    setErrored(false);
    setReached(0);
    setResult(null);
    setLog([{ kind: "stage", text: "빌더 초기화 — Hephaestus 빌더 에이전트 가동" }]);

    const { runId } = await api.hephaestus.build({ request: request.trim(), mode: mode || undefined, workspace });
    runIdRef.current = runId;
    const channel = api.hephaestus.buildEventChannel(runId);
    unsubRef.current = ev.on(channel, (raw) => {
      const e = raw as unknown as HephaestusBuildEvent;
      setReached((cur) => stageFromEvent(e, cur));
      if (e.kind === "partial") {
        setLog((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "partial") {
            return [...prev.slice(0, -1), { kind: "partial", text: (last.text + (e.text ?? "")).slice(-4000) }];
          }
          return [...prev, { kind: "partial", text: e.text ?? "" }];
        });
      } else if (e.kind === "stage") {
        setLog((prev) => [...prev, { kind: "stage", text: e.text ?? e.stage ?? "" }]);
      } else if (e.kind === "log") {
        setLog((prev) => [...prev, { kind: "log", text: e.text ?? "" }]);
      } else if (e.kind === "done") {
        setReached(STAGES.length);
        const r = e.result as { workspace?: string; securityScan?: unknown } | undefined;
        setResult({ workspace: r?.workspace ?? workspace, securityScan: r?.securityScan ?? null });
        setLog((prev) => [...prev, { kind: "done", text: "빌드 완료 — 패키지 생성됨" }]);
        setPhase("done");
        unsubRef.current?.();
      } else if (e.kind === "error") {
        setErrored(true);
        setLog((prev) => [...prev, { kind: "error", text: e.text ?? "오류" }]);
        setPhase("error");
        unsubRef.current?.();
      }
    });
    // 구독이 끝났음을 메인에 알려 버퍼링된 초기 이벤트(첫 stage 틱)를 flush 받는다.
    void api.hephaestus.buildReady(runId);
  };

  const cancel = () => {
    if (runIdRef.current) ipc()?.hephaestus.cancelBuild(runIdRef.current);
    setPhase("idle");
    setReached(0);
    unsubRef.current?.();
  };

  const reset = () => {
    setPhase("idle");
    setReached(0);
    setErrored(false);
    setLog([]);
    setResult(null);
  };

  const installToLibrary = async () => {
    if (!workspace) return;
    try {
      const imported = await ipc()?.team.importLocalFolder(workspace);
      setLog((prev) => [...prev, { kind: "log", text: "완료: 라이브러리에 설치됨 — 인스펙터로 이동합니다." }]);
      // 빌드→보유 전환: 설치 직후 해당 에이전트 인스펙터로 자동 점프(생애주기 동선 연결).
      if (imported?.id) navigate(`/library/agents?agentId=${imported.id}`);
    } catch (e) {
      setLog((prev) => [...prev, { kind: "error", text: `설치 실패: ${(e as Error).message}` }]);
    }
  };

  const upload = async (visibility: "private-link" | "marketplace") => {
    if (!workspace) return;
    setLog((prev) => [...prev, { kind: "stage", text: `업로드(${visibility === "marketplace" ? "Hub public" : "Cloud private"})...` }]);
    const res = await ipc()?.hephaestus.publish({ folder: workspace, visibility });
    setLog((prev) => [
      ...prev,
      { kind: res?.ok ? "done" : "error", text: res?.ok ? "완료: 업로드 완료" : `업로드 실패: ${res?.error ?? res?.stderr ?? "알 수 없음"}` },
    ]);
  };

  const engineMissing = status ? !status.available : false;
  const running = phase === "running";
  // 파이프라인은 항상 표시 — idle 에선 딤된 프리뷰로 무엇을 할지 보여준다.
  const showPipeline = true;

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
                <h1>Build</h1>
                <div className="build-subtitle">hep-build</div>
              </div>
            </div>
            <div className="build-header-status titlebar-nodrag">
              <KeyStatusBanner mode="pill" />
              {status?.available && (
                <span className="build-status-pill">
                  <IconBolt size={12} /> Python {status.version}
                </span>
              )}
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
            <div className="build-card build-composer">
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
                      onClick={() => setMode(active ? "" : m.id)}
                      disabled={running}
                      className="build-mode-card titlebar-nodrag"
                      data-active={active ? "true" : "false"}
                    >
                      <Icon size={16} />
                      <strong>{ko ? m.label : m.labelEn}</strong>
                      <span>{ko ? m.desc : m.descEn}</span>
                    </button>
                  );
                })}
              </div>

              {!running && (
                <div className="build-starters">
                  <span className="build-starters-label">{ko ? "스타터" : "Starters"}</span>
                  {STARTERS.map((s) => (
                    <button
                      key={s.prompt}
                      type="button"
                      className="build-starter-chip titlebar-nodrag"
                      onClick={() => setRequest(s.prompt)}
                    >
                      {ko ? s.ko : s.en}
                    </button>
                  ))}
                </div>
              )}

              <textarea
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                disabled={running}
                placeholder={ko ? "무엇을 시킬까요? 예) 인스타그램 마케팅 운영 에이전트" : "What should it do? e.g. an Instagram marketing agent"}
                rows={5}
                className="build-request-input titlebar-nodrag"
              />

              <div className="build-action-row">
                <button onClick={pickWorkspace} disabled={running} className="build-folder-button titlebar-nodrag">
                  <IconFolder size={15} />
                  <span>{workspace ? workspace.split("/").slice(-2).join("/") : ko ? "생성 폴더 선택" : "Choose output folder"}</span>
                </button>
                {running ? (
                  <button onClick={cancel} className="build-secondary-button titlebar-nodrag">{ko ? "중지" : "Stop"}</button>
                ) : phase === "done" || phase === "error" ? (
                  <button onClick={reset} className="build-secondary-button titlebar-nodrag">{ko ? "새 빌드" : "New build"}</button>
                ) : (
                  <button
                    onClick={start}
                    disabled={!request.trim() || !workspace || engineMissing}
                    className="build-primary-button titlebar-nodrag"
                  >
                    <IconWand size={15} /> {ko ? "빌드 시작" : "Start build"}
                  </button>
                )}
              </div>
            </div>

            {showPipeline && (
              <div className="build-card build-pipeline-card">
                <div className="build-card-head">
                  <span>{ko ? "파이프라인" : "Pipeline"}</span>
                  {running ? (
                    <span className="build-live">
                      <span className="forge-pulse" />
                      {ko ? STAGES[Math.min(reached, STAGES.length - 1)].label : STAGES[Math.min(reached, STAGES.length - 1)].labelEn}
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

          {phase === "done" && result && (
            <section className="build-card build-artifact-card">
              <div className="build-card-head">
                <span>{ko ? "산출물" : "Artifacts"}</span>
                <span>ready</span>
              </div>
              <ArtifactPreview workspace={result.workspace} ko={ko} />
              <VerifyGate scan={result.securityScan} ko={ko} />
              <BuildCostReceipt ko={ko} />
              <div className="build-result-actions">
                <span><IconCheck size={15} /> {ko ? "패키지 준비됨" : "Package ready"}</span>
                <button onClick={installToLibrary} className="build-primary-button titlebar-nodrag">{ko ? "라이브러리에 설치" : "Install to library"}</button>
                <button onClick={() => upload("private-link")} className="build-secondary-button titlebar-nodrag">{ko ? "Cloud private 업로드" : "Upload Cloud private"}</button>
                <button onClick={() => upload("marketplace")} className="build-secondary-button titlebar-nodrag">{ko ? "Hub public 제출" : "Submit Hub public"}</button>
              </div>
            </section>
          )}

          {log.length > 0 && (
            <section className="build-card build-log-card">
              <div className="build-card-head">
                <span>Build Log</span>
                {phase === "done" && <span>ready</span>}
              </div>
              <div className="build-log-body">
                {log.map((l, i) => (
                  <div key={i} data-kind={l.kind}>
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
function ArtifactPreview({ workspace, ko }: { workspace: string; ko: boolean }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipc()?.fs.listDirectory(workspace, true)
      .then((d) => { if (alive) setListing(d); })
      .catch((e) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, [workspace]);
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
function parseScan(scan: unknown): {
  unknown: boolean;
  tone: "ok" | "warn" | "block";
  pass: number;
  warn: number;
  blocker: number;
  items: { severity: string; message: string; file?: string }[];
} {
  if (!scan || typeof scan !== "object") {
    return { unknown: true, tone: "ok", pass: 0, warn: 0, blocker: 0, items: [] };
  }
  const obj = scan as Record<string, unknown>;
  const raw = Array.isArray(scan)
    ? (scan as unknown[])
    : Array.isArray(obj.findings)
      ? (obj.findings as unknown[])
      : [];
  const items = (raw as Record<string, unknown>[]).map((f) => ({
    severity: String(f?.severity ?? "info"),
    message: String(f?.message ?? f?.id ?? "항목"),
    file: typeof f?.file === "string" ? (f.file as string) : undefined,
  }));
  if (items.length === 0) {
    return { unknown: false, tone: "ok", pass: 0, warn: 0, blocker: 0, items: [] };
  }
  const blocker = items.filter((i) => i.severity === "blocker" || i.severity === "high").length;
  const warn = items.filter((i) => i.severity === "medium").length;
  const pass = items.length - blocker - warn;
  const tone = blocker > 0 ? "block" : warn > 0 ? "warn" : "ok";
  return { unknown: false, tone, pass, warn, blocker, items };
}

function VerifyGate({ scan, ko }: { scan: unknown; ko: boolean }) {
  const p = parseScan(scan);
  return (
    <div className="build-verify" data-tone={p.tone}>
      <div className="build-verify-head">
        <IconShield size={14} />
        <strong>{ko ? "안전 점검 (검증 게이트)" : "Safety check (verify gate)"}</strong>
      </div>
      {p.unknown ? (
        <p className="build-verify-note">
          {ko
            ? "보안 스캔 결과를 확인할 수 없습니다 (엔진이 결과를 반환하지 않음). 설치 전 수동 검토를 권장합니다."
            : "Security scan result unavailable (engine returned none). Manual review recommended before install."}
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
          <p className="build-verify-note">{ko ? "검증 통과·승인 후에만 설치/게시됩니다 — 자동 게시 없음." : "Installs/publishes only after passing and approval — no auto-publish."}</p>
        </>
      )}
    </div>
  );
}

// ── 빌드 비용 영수증 — 가치5(독립)를 칩이 아니라 '마진 ₩0' 사실로 증명. ──
function BuildCostReceipt({ ko }: { ko: boolean }) {
  return (
    <div className="build-cost-receipt">
      <div className="build-cost-row">
        <strong>{ko ? "빌드 비용" : "Build cost"}</strong>
        <span>{ko ? "당신의 구독/키에서 차감" : "billed to your subscription/keys"}</span>
      </div>
      <div className="build-cost-margin">{ko ? MARGIN_LINE_KO : MARGIN_LINE_EN}</div>
      <p>{ko ? "모델 호출을 Agentlas가 중계하지 않습니다 — 추가 요금 0." : "Agentlas does not relay model calls — zero extra fees."}</p>
    </div>
  );
}
