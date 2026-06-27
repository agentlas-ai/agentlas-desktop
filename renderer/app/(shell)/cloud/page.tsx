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
      setResult({
        ok: Boolean(res.ok),
        title: res.ok ? (ko ? "업로드 완료" : "Upload complete") : ko ? "업로드 중단" : "Upload stopped",
        issues,
        detail: detail ? detail.slice(0, 1600) : undefined,
      });
    } catch (err) {
      setResult({
        ok: false,
        title: ko ? "업로드 실패" : "Upload failed",
        issues: [],
        detail: err instanceof Error ? err.message : String(err),
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
