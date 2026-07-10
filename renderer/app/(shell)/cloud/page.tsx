"use client";
import { useState } from "react";
import type { CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconCheck, IconFileUp } from "@/components/Icon";

type Visibility = "private-link" | "marketplace";

type UploadIssue = {
  severity: string;
  message: string;
  file?: string;
  remediation?: string;
};

type CareerGraphProof = {
  indexStatus?: string;
  policy?: string;
  counts?: Record<string, number>;
  canonicalSources?: number;
  staleSourceCount?: number;
  nodeTypes?: Record<string, number>;
  edgeTypes?: Record<string, number>;
};

type UploadResult = {
  ok: boolean;
  title: string;
  issues: UploadIssue[];
  detail?: string;
  link?: string;
  careerGraph?: CareerGraphProof;
};

export default function CloudAgentPublishPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [rootPath, setRootPath] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private-link");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  async function chooseFolder() {
    const api = ipc();
    if (!api || running) return;
    const dir = await api.fs.pickDirectory();
    if (dir) {
      setRootPath(dir.path);
      setResult(null);
    }
  }

  async function upload() {
    const api = ipc();
    const folder = rootPath.trim();
    if (!api) return;
    if (!folder) {
      setResult({
        ok: false,
        title: ko ? "폴더를 먼저 선택하세요." : "Choose a folder first.",
        issues: [],
      });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await api.hephaestus.publish({ folder, visibility });
      const json = isRecord(res.json) ? res.json : null;
      const issues = extractIssues(res.json);
      const careerGraph = extractCareerGraph(json);
      if (res.ok) {
        const registration = json && isRecord(json.registration) ? json.registration : null;
        const link = registration && typeof registration.url === "string" ? registration.url : undefined;
        setResult({
          ok: true,
          title:
            visibility === "marketplace"
              ? ko ? "Agentlas Hub에 공개 등록되었습니다" : "Published to Agentlas Hub"
              : ko ? "Agentlas Cloud 보관함에 업로드되었습니다" : "Uploaded to Agentlas Cloud",
          issues,
          link,
          careerGraph,
        });
        return;
      }
      const classified = classifyUploadFailure(json, res.error, res.stderr, ko);
      setResult({
        ok: false,
        title: classified.title,
        issues: issues.length > 0 ? issues : classified.issue ? [classified.issue] : [],
        detail: buildFailureDetail(json, res.error, res.stderr, res.stdout),
        careerGraph,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const classified = classifyUploadFailure(null, detail, "", ko);
      setResult({
        ok: false,
        title: classified.title,
        issues: classified.issue ? [classified.issue] : [],
        detail,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "32px" }}>
      <section style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={iconPlate}>
            <IconFileUp size={18} />
          </div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 22, lineHeight: 1.2 }}>
            {ko ? "에이전트 업로드" : "Agent upload"}
          </h1>
        </header>

        <div className="glass-thin" style={panel}>
          <button onClick={chooseFolder} disabled={running} style={folderPicker}>
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
              {rootPath || (ko ? "업로드할 에이전트 폴더 선택" : "Choose an agent folder")}
            </span>
            <IconFileUp size={14} />
          </button>

          <div role="radiogroup" aria-label={ko ? "업로드 대상" : "Upload destination"} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <DestinationCard
              selected={visibility === "private-link"}
              disabled={running}
              onSelect={() => setVisibility("private-link")}
              title={ko ? "Agentlas Cloud" : "Agentlas Cloud"}
              subtitle={ko ? "비공개 링크 · 내 보관함" : "Private link · my storage"}
            />
            <DestinationCard
              selected={visibility === "marketplace"}
              disabled={running}
              onSelect={() => setVisibility("marketplace")}
              title={ko ? "Agentlas Hub" : "Agentlas Hub"}
              subtitle={ko ? "마켓플레이스 공개 · 라우팅 카드 필요" : "Public marketplace · routing card required"}
            />
          </div>

          <button onClick={() => void upload()} disabled={running || !rootPath.trim()} style={{ ...uploadButton, opacity: running || !rootPath.trim() ? 0.55 : 1 }}>
            <IconFileUp size={15} />
            {running ? (ko ? "검사 및 업로드 중..." : "Checking and uploading...") : ko ? "업로드" : "Upload"}
          </button>
        </div>

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
                {ko ? "업로드한 페이지 열기" : "Open uploaded page"}
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div style={metricBox}>
      <strong>{Number.isFinite(value) ? value : 0}</strong>
      <span>{label}</span>
    </div>
  );
}

function DestinationCard({
  selected,
  disabled,
  onSelect,
  title,
  subtitle,
}: {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 3,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        border: selected ? "2px solid var(--accent)" : "1px solid var(--paper-edge)",
        background: "var(--paper)",
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>{title}</span>
      <span style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.4 }}>{subtitle}</span>
    </button>
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
  const baseTitle = ko ? "업로드 중단" : "Upload stopped";
  const jsonError = json && typeof json.error === "string" ? json.error : "";
  const signal = [error ?? "", stderr, jsonError].join("\n").toLowerCase();

  if (/sign[\s-]?in|signed[_\s-]?out|unauthorized|http 401|\b401\b|auth login/.test(signal)) {
    return {
      title: ko ? "Agentlas 로그인이 필요합니다" : "Agentlas sign-in required",
      issue: {
        severity: "warning",
        message: ko ? "업로드는 시작되지 않았고 로컬 파일은 그대로입니다." : "Upload did not start and local files were not changed.",
        remediation: ko
          ? "업로드 로그인 창(브라우저)이 열리면 완료한 뒤 같은 폴더로 재시도하세요."
          : "Complete the browser sign-in that opens during upload, then retry with the same folder.",
      },
    };
  }
  if (json && json.status === "blocked") {
    const findings = isRecord(json.review) && Array.isArray(json.review.findings) ? json.review.findings : [];
    const onlyRoutingCard =
      findings.length > 0 &&
      findings.every((f) => isRecord(f) && typeof f.id === "string" && f.id.startsWith("routing-card"));
    if (onlyRoutingCard) {
      return {
        title: ko ? "Hub 공개에는 라우팅 카드가 필요합니다" : "Hub publishing needs a routing card",
        issue: {
          severity: "warning",
          message: ko
            ? "Hub 마켓플레이스 공개는 .agentlas/routing-card.json이 있어야 합니다. Cloud(비공개 링크) 업로드는 카드 없이도 가능합니다."
            : "Hub marketplace publishing requires .agentlas/routing-card.json. Cloud (private link) uploads work without one.",
          remediation: ko
            ? "빌드 화면에서 라우팅 카드를 생성하거나, 대상을 Agentlas Cloud로 바꿔 업로드하세요."
            : "Generate a routing card from the Build screen, or switch the destination to Agentlas Cloud.",
        },
      };
    }
    return {
      title: ko ? "업로드 전 검사에서 막혔습니다" : "Pre-upload review blocked the package",
      issue:
        findings.length > 0
          ? undefined
          : {
              severity: "error",
              message: ko ? "패키지 검사에서 차단 사유가 보고되었습니다." : "The package review reported blocking findings.",
            },
    };
  }
  if (signal.includes("unsafe_path")) {
    return {
      title: ko ? "안전하지 않은 파일 경로가 있습니다" : "Unsafe file path",
      issue: {
        severity: "error",
        message: ko
          ? "패키지 밖을 가리키는 경로가 있어 업로드를 멈췄습니다."
          : "A path appears to escape the package folder, so upload stopped.",
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
      message: ko ? "업로드가 끝나지 않았습니다. 로컬 파일은 그대로입니다." : "Upload did not finish. Local files were not changed.",
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

const uploadButton: CSSProperties = {
  height: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--ink)",
  color: "var(--paper)",
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
