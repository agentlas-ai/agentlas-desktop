"use client";
import { useState } from "react";
import type { CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { IconCheck, IconFileUp } from "@/components/Icon";

type UploadIssue = {
  severity: string;
  message: string;
  file?: string;
  remediation?: string;
};

type UploadResult = {
  ok: boolean;
  title: string;
  issues: UploadIssue[];
  detail?: string;
};

export default function CloudAgentPublishPage() {
  const { locale } = useT();
  const ko = locale !== "en";
  const [rootPath, setRootPath] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  async function chooseFolder() {
    const api = ipc();
    if (!api || running) return;
    const dir = await api.fs.pickDirectory();
    if (dir) {
      setRootPath(dir);
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
      const res = await api.hephaestus.publish({ folder, visibility: "private-link" });
      const issues = extractIssues(res.json);
      const detail = [res.error, res.stderr, res.stdout].filter(Boolean).join("\n").trim();
      const friendly = friendlyUploadMessage(detail, ko);
      setResult({
        ok: Boolean(res.ok),
        title: res.ok ? (ko ? "업로드 완료" : "Upload complete") : friendly.title,
        issues: issues.length > 0 ? issues : friendly.issue ? [friendly.issue] : [],
        detail: detail ? detail.slice(0, 1600) : undefined,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const friendly = friendlyUploadMessage(detail, ko);
      setResult({
        ok: false,
        title: friendly.title,
        issues: friendly.issue ? [friendly.issue] : [],
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

            <div style={{ marginTop: 14 }}>
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

            {result.detail && (
              <pre style={detailBox}>{result.detail}</pre>
            )}
          </section>
        )}
      </section>
    </div>
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

function friendlyUploadMessage(detail: string, ko: boolean): { title: string; issue?: UploadIssue } {
  const raw = detail.trim();
  const lower = raw.toLowerCase();
  const baseTitle = ko ? "업로드 중단" : "Upload stopped";
  if (!raw) return { title: baseTitle };
  if (lower.includes("sign in") || lower.includes("login") || lower.includes("auth") || lower.includes("unauthorized") || lower.includes("401")) {
    return {
      title: ko ? "로그인이 필요합니다" : "Sign in required",
      issue: {
        severity: "warning",
        message: ko ? "업로드는 시작되지 않았고 로컬 파일은 그대로입니다." : "Upload did not start and local files were not changed.",
        remediation: ko ? "Agentlas 계정으로 다시 로그인한 뒤 같은 폴더로 재시도하세요." : "Sign in to Agentlas again, then retry with the same folder.",
      },
    };
  }
  if (lower.includes("routing_card_required")) {
    return {
      title: ko ? "라우팅 정보가 필요합니다" : "Routing metadata required",
      issue: {
        severity: "warning",
        message: ko
          ? "Hub나 Cloud가 이 패키지를 어떻게 실행할지 알 수 없습니다."
          : "Hub or Cloud cannot tell how this package should run.",
        remediation: ko
          ? "routing-card.json 또는 agentlas.json의 라우팅 정보를 보강한 뒤 다시 업로드하세요."
          : "Add routing-card.json or routing metadata in agentlas.json, then retry.",
      },
    };
  }
  if (lower.includes("unsafe_path")) {
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
  if (lower.includes("manifest_missing") || lower.includes("agentlas.json")) {
    return {
      title: ko ? "agentlas.json을 먼저 고쳐야 합니다" : "Fix agentlas.json first",
      issue: {
        severity: "error",
        message: ko ? "패키지 설명 파일이 없거나 읽을 수 없습니다." : "The package manifest is missing or unreadable.",
        remediation: ko ? "패키지 wizard/복구를 실행한 뒤 다시 업로드하세요." : "Run the package wizard/repair step, then retry.",
      },
    };
  }
  if (lower.includes("needs-review") || lower.includes("acknowledge")) {
    return {
      title: ko ? "검토가 필요한 경고가 있습니다" : "Review required",
      issue: {
        severity: "warning",
        message: ko ? "위험 경고가 있어 바로 공개하지 않았습니다." : "Warnings were found, so the package was not published immediately.",
        remediation: ko ? "경고 내용을 확인하고 필요한 경우 승인 후 다시 업로드하세요." : "Review the warnings and retry with acknowledgement if appropriate.",
      },
    };
  }
  if (lower.includes("quota") || lower.includes("credit")) {
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
