"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconCheck, IconFileUp } from "@/components/Icon";
import { ElapsedClock } from "@/components/ElapsedClock";
import type {
  CloudAgentPublishStage,
  CloudAgentRegisteredUploadOption,
} from "@shared/types";
import { useSearchParams } from "next/navigation";
import {
  beginCloudUpload,
  finishCloudUpload,
  getCloudUploadServerSnapshot,
  getCloudUploadSnapshot,
  setCloudUploadPurposeAnswer,
  setCloudUploadRegisteredKey,
  setCloudUploadResult,
  setCloudUploadRootGrant,
  subscribeCloudUpload,
  type CloudUploadCareerGraphProof as CareerGraphProof,
  type CloudUploadIssue as UploadIssue,
  type CloudUploadResult as UploadResult,
  type CloudUploadVisibility as Visibility,
} from "@/lib/cloud-upload-session";

/**
 * The visible phase timeline. Research on long-running agent UIs is consistent:
 * for multi-minute work a phase timeline beats a percentage bar, because the
 * remaining time is genuinely unknown but the current phase never is. Main emits
 * every one of these; before this they existed only as an unused callback.
 */
const UPLOAD_PHASES: { key: CloudAgentPublishStage; ko: string; en: string; publicOnly?: boolean }[] = [
  { key: "starting", ko: "시작", en: "Starting" },
  { key: "cleaning", ko: "공개용 사본 정리", en: "Cleaning a publish copy", publicOnly: true },
  { key: "scanning", ko: "파일 안전 검사", en: "Scanning files" },
  { key: "packaging", ko: "패키지 생성", en: "Building the package" },
  { key: "reviewing", ko: "검토", en: "Reviewing" },
  { key: "uploading", ko: "업로드", en: "Uploading" },
  { key: "receipt", ko: "영수증 저장", en: "Saving the receipt" },
];

/** Sub-phases that report inside another phase rather than advancing the list. */
const UPLOAD_DETAIL_STAGES: Partial<Record<CloudAgentPublishStage, { ko: string; en: string }>> = {
  "routing-card": { ko: "라우팅 카드 생성", en: "Generating the routing card" },
  remediating: { ko: "차단 항목 자동 수정", en: "Auto-fixing a blocker" },
  blockers: { ko: "차단 항목 확인", en: "Blockers found" },
  excluded: { ko: "파일 제외", en: "Excluded a file" },
  "scan-clean": { ko: "차단 항목 없음", en: "No blockers left" },
  metadata: { ko: "다국어 메타데이터 생성", en: "Generating bilingual metadata" },
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

// UploadIssue / CareerGraphProof / UploadResult / Visibility 는 이제
// lib/cloud-upload-session.ts 가 소유한다 — 화면이 언마운트돼도 살아남아야 하는
// 값들이라 타입도 그 스토어와 같은 자리에 둔다.

function registeredOptionKey(option: CloudAgentRegisteredUploadOption): string {
  if ("firmId" in option.target) return `team:firm:${option.target.firmId}`;
  return `${option.target.entityKind}:agent:${option.target.agentId}`;
}

export default function CloudAgentPublishPage() {
  const { locale } = useT();
  const searchParams = useSearchParams();
  const requestedTeamId = searchParams.get("team");
  const ko = locale !== "en";
  // ★진행 상태는 이 화면이 소유하지 않는다 — 다른 메뉴로 갔다 와도 업로드가
  // 그대로 이어져 보여야 하므로 모듈 스토어(cloud-upload-session)가 소유한다.
  // 업로드는 Main에서 계속 돌고 있었는데 화면만 초기화되던 문제의 수리.
  const session = useSyncExternalStore(
    subscribeCloudUpload,
    getCloudUploadSnapshot,
    getCloudUploadServerSnapshot,
  );
  const { rootGrant, registeredKey, running, result, purposeAnswer, progressStage, progressDetail, startedAt } = session;
  const [registeredOptions, setRegisteredOptions] = useState<CloudAgentRegisteredUploadOption[]>([]);
  // 시계는 UploadProgressPanel 안의 ElapsedClock 리프가 스스로 돈다 —
  // 1,000줄 페이지를 초당 리렌더시키지 않는다.

  useEffect(() => {
    let cancelled = false;
    void ipc()?.cloudAgents.listRegisteredUploadOptions().then((options) => {
      if (!cancelled) {
        setRegisteredOptions(options);
        const requested = requestedTeamId ? options.find((option) => "firmId" in option.target && option.target.firmId === requestedTeamId) : null;
        if (requested) setCloudUploadRegisteredKey(registeredOptionKey(requested));
      }
    }).catch(() => {
      if (!cancelled) setRegisteredOptions([]);
    });
    return () => { cancelled = true; };
  }, [requestedTeamId]);

  const selectedRegistered = registeredOptions.find((option) => registeredOptionKey(option) === registeredKey) ?? null;

  async function chooseFolder() {
    const api = ipc();
    if (!api || running) return;
    const dir = await api.fs.pickDirectory();
    if (dir) setCloudUploadRootGrant(dir);
  }

  async function upload(visibility: Visibility, answer?: string) {
    const api = ipc();
    if (!api) return;
    if (!rootGrant && !selectedRegistered) {
      setCloudUploadResult({
        ok: false,
        title: ko ? "폴더를 먼저 선택하세요." : "Choose a folder first.",
        issues: [],
      });
      return;
    }
    // 이 실행의 소유권 표식. 화면을 떠났다 와도 스토어가 같은 id로 이어받는다.
    const progressId = beginCloudUpload(visibility);
    let outcome: UploadResult | null = null;
    try {
      const res = selectedRegistered
        ? visibility === "marketplace"
          ? await api.cloudAgents.publishRegisteredPublic({
              target: selectedRegistered.target,
              progressId,
              ...(answer?.trim() ? { purposeAnswer: answer.trim() } : {}),
            })
          : await api.cloudAgents.saveRegisteredPrivate({ target: selectedRegistered.target, progressId })
        : visibility === "marketplace"
          ? await api.cloudAgents.publishPublic({
              rootGrant: rootGrant!,
              progressId,
              ...(answer?.trim() ? { purposeAnswer: answer.trim() } : {}),
            })
          : await api.cloudAgents.savePrivate({ rootGrant: rootGrant!, progressId });
      const json = res as unknown as Record<string, unknown>;
      const issues = extractIssues(res);
      const findings = isRecord(json.review) && Array.isArray(json.review.findings)
        ? json.review.findings
        : [];
      const needsPurpose = findings.some(
        (finding) => isRecord(finding) && finding.id === "agent-purpose-missing",
      );
      const careerGraph = extractCareerGraph(json);
      if (res.status === "registered") {
        const link = visibility === "marketplace"
          ? res.registration?.marketplaceUrl ?? res.registration?.url
          : res.registration?.url;
        outcome = {
          ok: true,
          title:
            visibility === "marketplace"
              ? ko ? "Agentlas Hub에 공개 등록되었습니다" : "Published to Agentlas Hub"
              : ko ? "내 Agent Cloud에 비공개 저장되었습니다" : "Saved privately in my Agent Cloud",
          issues,
          visibility,
          link,
          careerGraph,
        };
        return;
      }
      const classified = classifyUploadFailure(json, undefined, "", ko);
      outcome = {
        ok: false,
        title: classified.title,
        issues: issues.length > 0 ? issues : classified.issue ? [classified.issue] : [],
        visibility,
        detail: buildFailureDetail(json, undefined, "", ""),
        careerGraph,
        needsPurpose,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const classified = classifyUploadFailure(null, detail, "", ko);
      outcome = {
        ok: false,
        title: classified.title,
        issues: classified.issue ? [classified.issue] : [],
        visibility,
        detail,
      };
    } finally {
      // 어느 경로로 끝나든 실행은 끝났다. 결과도 스토어가 받는다 — 사용자가 화면을
      // 떠나 있는 동안 끝나도 돌아왔을 때 결과가 그대로 있어야 한다.
      finishCloudUpload(progressId, outcome);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "32px" }}>
      <section style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        <header style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={iconPlate}>
            <IconFileUp size={18} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 22, lineHeight: 1.2 }}>
              {ko ? "에이전트 저장 및 공개" : "Save or publish an agent"}
            </h1>
            <p style={{ margin: "6px 0 0", color: "var(--muted-deep)", fontSize: 13, lineHeight: 1.55 }}>
              {ko
                ? "기본은 내 Agent Cloud에 비공개 저장입니다. Hub 공개 발행은 별도 작업으로만 실행됩니다."
                : "Private storage in your Agent Cloud is the default. Public Hub publishing is always a separate action."}
            </p>
          </div>
        </header>

        <div className="glass-thin" style={panel}>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label htmlFor="registered-agent-upload" style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)" }}>
              {ko ? "내 에이전트에서 선택" : "Choose from My Agents"}
            </label>
            <select
              id="registered-agent-upload"
              value={registeredKey}
              disabled={Boolean(running)}
              onChange={(event) => {
                setCloudUploadRegisteredKey(event.target.value);
              }}
              style={{ ...folderPicker, width: "100%", appearance: "auto" }}
            >
              <option value="">{ko ? "등록된 팀 또는 독립 에이전트 선택" : "Select a registered team or standalone agent"}</option>
              {registeredOptions.map((option) => (
                <option
                  key={registeredOptionKey(option)}
                  value={registeredOptionKey(option)}
                  disabled={!option.sourceReady}
                >
                  {option.entityKind === "team" ? (ko ? "팀" : "Team") : (ko ? "에이전트" : "Agent")} · {option.name}
                  {!option.sourceReady ? (ko ? " · 원본 폴더 없음" : " · source folder unavailable") : ""}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.45 }}>
              {ko
                ? "팀은 하위 에이전트를 낱개로 펼치지 않고 팀 패키지 하나로 관리·업로드합니다."
                : "Teams are managed and uploaded as one package, not flattened into individual sub-agents."}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--muted-deep)", fontSize: 11 }}>
            <span style={{ height: 1, background: "var(--line)", flex: 1 }} />
            {ko ? "또는 로컬 폴더" : "or a local folder"}
            <span style={{ height: 1, background: "var(--line)", flex: 1 }} />
          </div>
          <button onClick={chooseFolder} disabled={Boolean(running)} style={folderPicker}>
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
              {rootGrant?.path || (ko ? "저장할 에이전트 폴더 선택" : "Choose an agent folder")}
            </span>
            <IconFileUp size={14} />
          </button>

          <div style={actionGrid}>
            <CloudAction
              title={ko ? "Agent Cloud 비공개 저장" : "Private Agent Cloud save"}
              description={ko
                ? "소유자 계정에만 저장합니다. 공개 심사와 라우팅 카드 없이, 로컬에서 비밀값·경로·파일 해시를 확인합니다."
                : "Stores only for the owner. No public review or routing card; secrets, paths, and file hashes are checked locally."}
              buttonLabel={ko ? "내 Cloud에 비공개 저장" : "Save privately to my Cloud"}
              busyLabel={ko ? "안전 검사 후 저장 중..." : "Checking and saving..."}
              busy={running === "private-link"}
              disabled={Boolean(running) || (!rootGrant && !selectedRegistered)}
              primary
              onClick={() => void upload("private-link")}
            />
            <CloudAction
              title={ko ? "Agentlas Hub 공개 발행" : "Public Agentlas Hub publish"}
              description={ko
                ? "다른 사용자가 찾고 빌릴 수 있게 공개합니다. 공개 품질 검토와 유효한 라우팅 카드가 필요합니다."
                : "Makes the agent discoverable and borrowable. Public quality review and a valid routing card are required."}
              buttonLabel={ko ? "Hub에 공개 발행" : "Publish publicly to Hub"}
              busyLabel={ko ? "공개 검사 후 발행 중..." : "Reviewing and publishing..."}
              busy={running === "marketplace"}
              disabled={Boolean(running) || (!rootGrant && !selectedRegistered)}
              onClick={() => void upload("marketplace")}
            />
          </div>
        </div>

        {running && (
          <UploadProgressPanel
            ko={ko}
            visibility={running}
            stage={progressStage}
            detail={progressDetail}
            startedAt={startedAt}
          />
        )}

        {result && (
          <section className="glass-thin" style={panel}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ ...statusIcon, color: result.ok ? "var(--green-deep)" : "var(--red-deep)" }}>
                {result.ok ? <IconCheck size={17} /> : "!"}
              </span>
              <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 16 }}>
                {result.title}
              </h2>
            </div>

            {result.link && (
              <button
                onClick={() => window.open(result.link, "_blank", "noopener,noreferrer")}
                style={linkButton}
              >
                {result.visibility === "marketplace"
                  ? ko ? "Hub 페이지 열기" : "Open Hub page"
                  : ko ? "Agent Cloud에서 보기" : "View in Agent Cloud"}
                <span style={{ color: "var(--muted-deep)", fontSize: 11, fontFamily: "var(--font-mono)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {result.link}
                </span>
              </button>
            )}

            <div style={{ marginTop: 4 }}>
              {result.issues.length === 0 ? (
                <div style={notice}>{result.ok ? (ko ? "문제 없음" : "No issues found") : (ko ? "검사 결과가 비어 있습니다." : "No review details returned.")}</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {result.issues.map((issue, index) => (
                    <IssueRow key={`${issue.severity}-${index}`} issue={issue} />
                  ))}
                </div>
              )}
            </div>

            {result.needsPurpose && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <label htmlFor="agent-purpose-answer" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>
                  {ko
                    ? "이 에이전트가 끝내야 할 일과 완성된 결과를 평소 말로 적어주세요."
                    : "In ordinary words, what should this agent finish and what should the result look like?"}
                </label>
                <textarea
                  id="agent-purpose-answer"
                  value={purposeAnswer}
                  onChange={(event) => setCloudUploadPurposeAnswer(event.target.value)}
                  maxLength={1200}
                  rows={4}
                  placeholder={ko
                    ? "예: 고객 인터뷰 메모를 읽고 핵심 문제, 반복되는 요구, 다음 제품 실험을 한 장짜리 보고서로 정리해줘."
                    : "Example: Read customer interview notes and produce a one-page report of key problems, repeated needs, and the next product experiment."}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--paper-edge)",
                    background: "var(--paper)",
                    color: "var(--ink)",
                    padding: 11,
                    font: "inherit",
                    lineHeight: 1.5,
                  }}
                />
                <button
                  type="button"
                  disabled={Boolean(running) || purposeAnswer.trim().length < 12}
                  onClick={() => void upload("marketplace", purposeAnswer)}
                  style={{
                    ...actionButton,
                    border: "none",
                    background: "var(--ink)",
                    color: "var(--paper)",
                    opacity: Boolean(running) || purposeAnswer.trim().length < 12 ? 0.55 : 1,
                  }}
                >
                  {running
                    ? ko ? "카드를 채우고 다시 발행 중..." : "Filling the card and retrying..."
                    : ko ? "Agentlas가 채운 뒤 다시 발행" : "Let Agentlas fill it and retry"}
                </button>
              </div>
            )}

            {result.careerGraph && <CareerGraphProofBox proof={result.careerGraph} ko={ko} />}

            {result.detail && (
              <pre style={detailBox}>{result.detail}</pre>
            )}
          </section>
        )}
      </section>
    </div>
  );
}

function CareerGraphProofBox({ proof, ko }: { proof: CareerGraphProof; ko: boolean }) {
  const counts = proof.counts ?? {};
  const topNodeTypes = topEntries(proof.nodeTypes, 4);
  const topEdgeTypes = topEntries(proof.edgeTypes, 4);
  return (
    <section aria-label={ko ? "Career Graph 공개 증거" : "Career Graph public proof"} style={careerGraphBox}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 900, color: "var(--ink)" }}>
            {ko ? "Career Graph 공개 증거" : "Career Graph proof"}
          </h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--muted-deep)" }}>
            {ko
              ? "로컬 원본은 제외하고 집계된 경력/실행 증거만 포함됩니다."
              : "Only redacted aggregate career and execution evidence is included."}
          </p>
        </div>
        <span style={careerGraphBadge}>{proof.indexStatus || "indexed"}</span>
      </div>
      <div style={careerGraphMetrics}>
        <Metric label={ko ? "Sources" : "Sources"} value={counts.sources ?? proof.canonicalSources ?? 0} />
        <Metric label={ko ? "Nodes" : "Nodes"} value={counts.nodes ?? 0} />
        <Metric label={ko ? "Edges" : "Edges"} value={counts.edges ?? 0} />
        <Metric label={ko ? "Stale" : "Stale"} value={proof.staleSourceCount ?? 0} />
      </div>
      {(topNodeTypes.length > 0 || topEdgeTypes.length > 0) && (
        <div style={careerGraphTags}>
          {[...topNodeTypes, ...topEdgeTypes].map(([label, value]) => (
            <span key={label} style={careerGraphTag}>
              {label}
              <b>{value}</b>
            </span>
          ))}
        </div>
      )}
      <div style={careerGraphPolicy}>
        {proof.policy || "redacted_aggregate_projection"}
      </div>
    </section>
  );
}

/**
 * Live upload timeline. Four layers, in the order a stuck user asks for them:
 * (1) an always-advancing elapsed clock, (2) the current phase by name,
 * (3) the phases already done and still to come, (4) the last low-level detail
 * Main reported (file being fixed, blocker count, slug being uploaded).
 */
function UploadProgressPanel({
  ko,
  visibility,
  stage,
  detail,
  startedAt,
}: {
  ko: boolean;
  visibility: Visibility;
  stage: CloudAgentPublishStage | null;
  detail: string;
  startedAt: number | null;
}) {
  const isPublic = visibility === "marketplace";
  const phases = UPLOAD_PHASES.filter((phase) => isPublic || !phase.publicOnly);
  const subPhase = stage ? UPLOAD_DETAIL_STAGES[stage] : undefined;
  // A sub-phase reports inside whichever phase is already active, so the
  // timeline must not rewind to "starting" when one arrives.
  const activeIndex = (() => {
    const direct = phases.findIndex((phase) => phase.key === stage);
    if (direct >= 0) return direct;
    if (stage === "routing-card" || stage === "remediating" || stage === "blockers" || stage === "excluded" || stage === "scan-clean") {
      return Math.max(0, phases.findIndex((phase) => phase.key === "cleaning"));
    }
    if (stage === "metadata") return Math.max(0, phases.findIndex((phase) => phase.key === "packaging") - 1);
    return 0;
  })();

  return (
    <section className="glass-thin" style={panel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span className="forge-pulse" />
          <strong style={{ fontSize: 13.5, color: "var(--ink)" }}>
            {ko
              ? isPublic ? "Hub에 공개 발행 중" : "Agent Cloud에 저장 중"
              : isPublic ? "Publishing to Hub" : "Saving to Agent Cloud"}
          </strong>
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted-deep)", fontVariantNumeric: "tabular-nums" }}>
          <ElapsedClock startedAt={startedAt} format={formatElapsed} />
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
        {phases.map((phase, index) => {
          const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
          return (
            <div
              key={phase.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "5px 0",
                opacity: state === "pending" ? 0.42 : 1,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 999,
                  border: state === "pending" ? "1px solid var(--paper-edge)" : "none",
                  background: state === "done" ? "var(--green-deep)" : state === "active" ? "var(--ink)" : "transparent",
                  color: "var(--paper)",
                  flexShrink: 0,
                }}
              >
                {state === "done" ? <IconCheck size={10} /> : state === "active" ? <span className="forge-pulse" style={{ background: "var(--paper)" }} /> : null}
              </span>
              <span style={{ fontSize: 12.5, color: state === "active" ? "var(--ink)" : "var(--ink-soft)", fontWeight: state === "active" ? 750 : 500 }}>
                {ko ? phase.ko : phase.en}
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 4,
          padding: "8px 10px",
          borderRadius: "var(--radius-md)",
          background: "var(--paper-2, var(--paper))",
          border: "1px solid var(--paper-edge)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--muted-deep)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {subPhase ? (ko ? subPhase.ko : subPhase.en) : ko ? "진행 중" : "Working"}
        {detail ? ` · ${detail}` : ""}
      </div>

      <p style={{ margin: 0, fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
        {ko
          ? "이 창을 닫지 마세요. 실패해도 원본 폴더는 수정되지 않습니다."
          : "Keep this window open. Your original folder is never modified, even on failure."}
      </p>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={metricBox}>
      <strong>{Number.isFinite(value) ? value : 0}</strong>
      <span>{label}</span>
    </div>
  );
}

function CloudAction({
  title,
  description,
  buttonLabel,
  busyLabel,
  busy,
  disabled,
  primary = false,
  onClick,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <section style={actionCard}>
      <div style={{ flex: 1 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: "var(--ink)", fontWeight: 850 }}>{title}</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.55 }}>
          {description}
        </p>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        style={{
          ...actionButton,
          border: primary ? "none" : "1px solid var(--paper-edge)",
          background: primary ? "var(--ink)" : "var(--paper)",
          color: primary ? "var(--paper)" : "var(--ink)",
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <IconFileUp size={14} />
        {busy ? busyLabel : buttonLabel}
      </button>
    </section>
  );
}

function IssueRow({ issue }: { issue: UploadIssue }) {
  return (
    <div style={issueRow}>
      <span style={severityDot(issue.severity)} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <strong style={{ fontSize: 12, textTransform: "uppercase" }}>{issue.severity}</strong>
          {issue.file && <span style={issueFile}>{issue.file}</span>}
        </div>
        <div style={{ marginTop: 3, fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>{issue.message}</div>
        {issue.remediation && <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted-deep)", lineHeight: 1.45 }}>{issue.remediation}</div>}
      </div>
    </div>
  );
}

function extractIssues(json: unknown): UploadIssue[] {
  const root = isRecord(json) ? json : {};
  const candidates = [
    root.findings,
    root.issues,
    isRecord(root.review) ? root.review.findings : null,
    isRecord(root.security) ? root.security.findings : null,
    isRecord(root.report) ? root.report.findings : null,
  ];
  const rows = candidates.flatMap((item) => (Array.isArray(item) ? item : []));
  return rows.map((row, index) => {
    const item = isRecord(row) ? row : {};
    return {
      severity: String(item.severity ?? item.level ?? "info"),
      message: String(item.message ?? item.title ?? item.detail ?? row ?? `Issue ${index + 1}`),
      file: typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : undefined,
      remediation: typeof item.remediation === "string" ? item.remediation : undefined,
    };
  });
}

function extractCareerGraph(json: Record<string, unknown> | null): CareerGraphProof | undefined {
  const manifest = json && isRecord(json.manifest) ? json.manifest : null;
  const bundle = json && isRecord(json.bundle) ? json.bundle : null;
  const fromManifest = manifest && isRecord(manifest.careerGraph) ? manifest.careerGraph : null;
  const fromBundle = bundle && isRecord(bundle.careerGraph) ? bundle.careerGraph : null;
  const card = fromManifest ?? fromBundle;
  if (!card || card.kind !== "agentlas-public-career-card") return undefined;
  return {
    indexStatus: typeof card.indexStatus === "string" ? card.indexStatus : undefined,
    policy: typeof card.policy === "string" ? card.policy : undefined,
    counts: numberRecord(card.counts),
    canonicalSources: typeof card.canonicalSources === "number" ? card.canonicalSources : undefined,
    staleSourceCount: typeof card.staleSourceCount === "number" ? card.staleSourceCount : undefined,
    nodeTypes: numberRecord(card.nodeTypes),
    edgeTypes: numberRecord(card.edgeTypes),
  };
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const next: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) next[key] = raw;
  }
  return Object.keys(next).length ? next : undefined;
}

function topEntries(value: Record<string, number> | undefined, limit: number): Array<[string, number]> {
  if (!value) return [];
  return Object.entries(value)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** 실패 원인 분류 — 엔진의 구조화 JSON을 우선하고, 텍스트 스니핑은 error/stderr에만 한다.
 *  stdout에는 패키지 번들(base64 포함)이 통째로 실려 오므로 절대 분류에 쓰지 않는다
 *  (예전엔 "author" 같은 substring이 "auth"에 걸려 가짜 "로그인이 필요합니다"가 떴다). */
function classifyUploadFailure(
  json: Record<string, unknown> | null,
  error: string | undefined,
  stderr: string,
  ko: boolean,
): { title: string; issue?: UploadIssue } {
  const manifest = json && isRecord(json.manifest) ? json.manifest : null;
  const publicHub = manifest?.visibility === "marketplace";
  const baseTitle = ko ? "저장 또는 발행 중단" : "Save or publish stopped";
  const jsonError = json && typeof json.error === "string" ? json.error : "";
  const signal = [error ?? "", stderr, jsonError].join("\n").toLowerCase();

  if (signal.includes("cloud_agent_revision_conflict") || signal.includes("changed on another machine")) {
    return {
      title: ko ? "다른 PC에서 이 에이전트가 먼저 변경되었습니다" : "This agent changed on another machine",
      issue: {
        severity: "warning",
        message: ko
          ? "서버의 최신 버전을 덮어쓰지 않았고, 이 PC의 로컬 파일도 그대로입니다."
          : "The newer Cloud version was not overwritten, and this machine's local files remain unchanged.",
        remediation: ko
          ? "Agent Cloud에서 최신 사본을 복원해 차이를 확인한 뒤 다시 저장하세요."
          : "Restore the latest Agent Cloud copy, review the differences, then save again.",
      },
    };
  }
  if (signal.includes("cloud_precondition_required")) {
    return {
      title: ko ? "최신 Cloud 버전을 먼저 복원해야 합니다" : "Restore the latest Cloud version first",
      issue: {
        severity: "warning",
        message: ko
          ? "이 폴더에는 안전한 업데이트에 필요한 Cloud revision 영수증이 없습니다."
          : "This folder does not have the Cloud revision receipt required for a safe update.",
        remediation: ko
          ? "최신 사본을 복원한 뒤 편집하고 다시 저장하세요."
          : "Restore the latest copy, edit it, then save again.",
      },
    };
  }
  if (/sign[\s-]?in|signed[_\s-]?out|unauthorized|http 401|\b401\b|auth login/.test(signal)) {
    return {
      title: ko ? "Agentlas 로그인이 필요합니다" : "Agentlas sign-in required",
      issue: {
        severity: "warning",
        message: ko ? "저장 또는 발행은 시작되지 않았고 로컬 파일은 그대로입니다." : "Save or publish did not start and local files were not changed.",
        remediation: ko
          ? "Agentlas 로그인을 완료한 뒤 같은 폴더로 재시도하세요."
          : "Complete Agentlas sign-in, then retry with the same folder.",
      },
    };
  }
  if (json && json.status === "blocked") {
    const findings = isRecord(json.review) && Array.isArray(json.review.findings) ? json.review.findings : [];
    const purposeQuestion = findings.find(
      (finding) => isRecord(finding) && finding.id === "agent-purpose-missing",
    );
    if (isRecord(purposeQuestion)) {
      return {
        title: ko ? "한 가지만 알려주세요" : "One quick question",
        issue: {
          severity: "warning",
          message: typeof purposeQuestion.message === "string"
            ? purposeQuestion.message
            : ko
              ? "이 에이전트가 구체적으로 어떤 일을 끝내야 하고, 완성된 결과는 어떤 모습이어야 하나요?"
              : "What concrete work should this agent complete, and what should the finished result look like?",
          remediation: ko
            ? "일반적인 말로 답하면 Agentlas가 내부 설명을 자동으로 채우고 다시 업로드합니다."
            : "Answer in ordinary words. Agentlas will fill its internal description and retry.",
        },
      };
    }
    const onlyRoutingCard =
      findings.length > 0 &&
      findings.every((f) => isRecord(f) && typeof f.id === "string" && f.id.startsWith("routing-card"));
    if (onlyRoutingCard) {
      return {
        title: ko ? "Hub 공개에는 라우팅 카드가 필요합니다" : "Hub publishing needs a routing card",
        issue: {
          severity: "warning",
          message: ko
            ? "Hub 공개 발행은 .agentlas/routing-card.json이 있어야 합니다. 소유자 전용 Agent Cloud 저장에는 이 카드가 필요하지 않습니다."
            : "Public Hub publishing requires .agentlas/routing-card.json. Owner-private Agent Cloud saves do not.",
          remediation: ko
            ? "라우팅 카드를 준비해 다시 공개 발행하거나, 별도 비공개 저장 버튼을 사용하세요."
            : "Prepare a routing card and publish again, or use the separate private-save action.",
        },
      };
    }
    return {
      title: publicHub
        ? ko ? "Hub 공개 심사에서 막혔습니다" : "Public Hub review blocked the package"
        : ko ? "비공개 저장 안전 검사에서 막혔습니다" : "Private-save safety checks blocked the package",
      issue:
        findings.length > 0
          ? undefined
          : {
              severity: "error",
              message: ko ? "로컬 패키지 검사에서 차단 사유가 보고되었습니다." : "Local package checks reported blocking findings.",
            },
    };
  }
  if (signal.includes("unsafe_path")) {
    return {
      title: ko ? "안전하지 않은 파일 경로가 있습니다" : "Unsafe file path",
      issue: {
        severity: "error",
        message: ko
          ? "패키지 밖을 가리키는 경로가 있어 저장 또는 발행을 멈췄습니다."
          : "A path appears to escape the package folder, so save or publish stopped.",
        remediation: ko
          ? "절대경로, .., 심볼릭 링크를 확인하고 패키지 폴더 안의 파일만 포함하세요."
          : "Check absolute paths, .. segments, and symlinks; include only files inside the package folder.",
      },
    };
  }
  if (signal.includes("manifest_missing") || signal.includes("agent folder not found")) {
    return {
      title: ko ? "agentlas.json을 먼저 고쳐야 합니다" : "Fix agentlas.json first",
      issue: {
        severity: "error",
        message: ko ? "패키지 설명 파일이 없거나 읽을 수 없습니다." : "The package manifest is missing or unreadable.",
        remediation: ko ? "패키지 wizard/복구를 실행한 뒤 다시 업로드하세요." : "Run the package wizard/repair step, then retry.",
      },
    };
  }
  if (signal.includes("needs-review") || signal.includes("acknowledge")) {
    return {
      title: ko ? "검토가 필요한 경고가 있습니다" : "Review required",
      issue: {
        severity: "warning",
        message: ko ? "위험 경고가 있어 바로 공개하지 않았습니다." : "Warnings were found, so the package was not published immediately.",
        remediation: ko ? "경고 내용을 확인하고 필요한 경우 승인 후 다시 업로드하세요." : "Review the warnings and retry with acknowledgement if appropriate.",
      },
    };
  }
  if (signal.includes("quota") || signal.includes("credit")) {
    return {
      title: ko ? "크레딧 또는 사용량 확인이 필요합니다" : "Credit or quota check needed",
      issue: {
        severity: "warning",
        message: ko ? "계정 한도 때문에 업로드가 멈췄을 수 있습니다." : "The upload may have stopped because of account quota.",
        remediation: ko ? "계정/크레딧 상태를 확인한 뒤 다시 시도하세요." : "Check account and credit status, then retry.",
      },
    };
  }
  return {
    title: baseTitle,
    issue: {
      severity: "error",
      message: ko ? "저장 또는 발행이 끝나지 않았습니다. 로컬 파일은 그대로입니다." : "Save or publish did not finish. Local files were not changed.",
      remediation: ko ? "세부 정보가 길면 기술 상세를 펼쳐 원인을 확인한 뒤 같은 폴더로 다시 시도하세요." : "Use the technical details below for diagnosis, then retry with the same folder.",
    },
  };
}

/** 기술 상세 — error/stderr/엔진 요약만. 번들 JSON(stdout)은 엔진 JSON 파싱 실패 시에만 꼬리를 보여준다. */
function buildFailureDetail(
  json: Record<string, unknown> | null,
  error: string | undefined,
  stderr: string,
  stdout: string,
): string | undefined {
  const parts = [error, stderr.trim()];
  if (json) {
    if (typeof json.error === "string") parts.push(json.error);
    if (typeof json.summary === "string") parts.push(json.summary);
  } else if (stdout.trim()) {
    parts.push(stdout.trim().slice(-1200));
  }
  const detail = parts.filter(Boolean).join("\n").trim();
  return detail ? detail.slice(0, 1600) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function severityDot(severity: string): CSSProperties {
  const s = severity.toLowerCase();
  const color = s.includes("block") || s.includes("high") || s.includes("error")
    ? "var(--red-deep)"
    : s.includes("medium") || s.includes("warn")
      ? "var(--amber-deep)"
      : "var(--green-deep)";
  return { width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 6, flexShrink: 0 };
}

const panel: CSSProperties = {
  padding: 16,
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--glass-border)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const iconPlate: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: "var(--radius-md)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  boxShadow: "var(--neu-raised)",
  color: "var(--accent)",
};

const folderPicker: CSSProperties = {
  minHeight: 46,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 13px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 13,
  cursor: "pointer",
};

const actionGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: 10,
};

const actionCard: CSSProperties = {
  minWidth: 0,
  minHeight: 170,
  padding: 14,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const actionButton: CSSProperties = {
  height: 44,
  width: "100%",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: "var(--radius-md)",
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
};

const linkButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
  padding: "9px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  textAlign: "left",
};

const statusIcon: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  fontWeight: 900,
};

const notice: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 13,
};

const careerGraphBox: CSSProperties = {
  marginTop: 2,
  padding: 12,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const careerGraphBadge: CSSProperties = {
  flexShrink: 0,
  padding: "4px 8px",
  borderRadius: 999,
  background: "color-mix(in srgb, var(--green-deep) 12%, transparent)",
  color: "var(--green-deep)",
  fontSize: 11,
  fontWeight: 900,
  textTransform: "uppercase",
};

const careerGraphMetrics: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 8,
};

const metricBox: CSSProperties = {
  minWidth: 0,
  padding: "8px 9px",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const careerGraphTags: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const careerGraphTag: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  minWidth: 0,
  maxWidth: "100%",
  padding: "4px 7px",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  color: "var(--ink-soft)",
  fontSize: 11,
};

const careerGraphPolicy: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--muted-deep)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

const issueRow: CSSProperties = {
  display: "flex",
  gap: 10,
  padding: 12,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
};

const issueFile: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
  color: "var(--muted-deep)",
  fontFamily: "var(--font-mono)",
};

const detailBox: CSSProperties = {
  margin: "12px 0 0",
  maxHeight: 220,
  overflow: "auto",
  padding: 12,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};
