"use client";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  CloudAgentPackageResult,
  CloudAgentReviewMode,
  CloudAgentSecurityFinding,
  RuntimeStatus,
} from "@/lib/types";
import { IconCheck, IconFileUp, IconKey, IconShield, IconStore } from "@/components/Icon";

export default function CloudAgentPublishPage() {
  const { t } = useT();
  const [rootPath, setRootPath] = useState("");
  const [reviewMode, setReviewMode] = useState<CloudAgentReviewMode>("static-only");
  const [running, setRunning] = useState<"dry-run" | "publish" | null>(null);
  const [result, setResult] = useState<CloudAgentPackageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeRuntime, setActiveRuntime] = useState<RuntimeStatus | null>(null);
  // Hephaestus 엔진(upload.py) 직접 검수/업로드 — 데스크탑 자체 cloudAgents 경로와 별개로 실엔진 연결.
  const [hephRunning, setHephRunning] = useState<"review" | "private-link" | "marketplace" | null>(null);
  const [hephMsg, setHephMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.runtime.detect().then((runtimes) => {
      setActiveRuntime(runtimes.find((runtime) => runtime.active) ?? runtimes[0] ?? null);
    });
  }, []);

  const statusLabel = useMemo(() => {
    if (!result) return "";
    if (result.status === "registered") return t("cloud.registered");
    if (result.status === "blocked") return t("cloud.blocked");
    return t("cloud.ready");
  }, [result, t]);

  async function chooseFolder() {
    const api = ipc();
    if (!api) return;
    const dir = await api.fs.pickDirectory();
    if (dir) {
      setRootPath(dir);
      setResult(null);
      setError(null);
    }
  }

  async function run(mode: "dry-run" | "publish") {
    const api = ipc();
    if (!api) return;
    if (!rootPath.trim()) {
      setError(t("cloud.no_folder"));
      return;
    }
    setRunning(mode);
    setError(null);
    try {
      if (mode === "publish") {
        const session = await api.auth.getSession();
        if (!session.signedIn) {
          const next = await api.auth.signInWithGoogle();
          if (!next.signedIn) {
            setError(t("cloud.signin"));
            return;
          }
        }
      }
      const next = await api.cloudAgents.publish({
        rootPath: rootPath.trim(),
        reviewMode,
        visibility: "marketplace",
        dryRun: mode === "dry-run",
      });
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  }

  // Hephaestus 엔진(upload.py)으로 직접 정적 검수.
  async function engineReview() {
    const api = ipc();
    if (!api || !rootPath.trim()) {
      setError(t("cloud.no_folder"));
      return;
    }
    setHephRunning("review");
    setHephMsg(null);
    try {
      const res = await api.hephaestus.package({ folder: rootPath.trim(), visibility: "marketplace" });
      const j = (res?.json ?? {}) as Record<string, unknown>;
      const findings = (j.findings ?? j.issues ?? []) as unknown[];
      setHephMsg({
        ok: Boolean(res?.ok),
        text: res?.ok
          ? `엔진 정적 검수 완료 — ${Array.isArray(findings) ? findings.length : 0}건 발견. 업로드 준비됨.`
          : `검수 실패: ${res?.error ?? res?.stderr?.slice(0, 300) ?? "알 수 없음"}`,
      });
    } catch (err) {
      setHephMsg({ ok: false, text: (err as Error).message });
    } finally {
      setHephRunning(null);
    }
  }

  // Hephaestus 엔진(upload.py)으로 직접 업로드(Cloud=private-link / Hub=marketplace).
  async function enginePublish(visibility: "private-link" | "marketplace") {
    const api = ipc();
    if (!api || !rootPath.trim()) {
      setError(t("cloud.no_folder"));
      return;
    }
    setHephRunning(visibility);
    setHephMsg(null);
    try {
      const res = await api.hephaestus.publish({ folder: rootPath.trim(), visibility });
      setHephMsg({
        ok: Boolean(res?.ok),
        text: res?.ok
          ? `✓ Hephaestus 엔진 업로드 완료 (${visibility === "marketplace" ? "Hub" : "Cloud"})`
          : `업로드 실패: ${res?.error ?? res?.stderr?.slice(0, 300) ?? "알 수 없음"}`,
      });
    } catch (err) {
      setHephMsg({ ok: false, text: (err as Error).message });
    } finally {
      setHephRunning(null);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "28px 32px" }}>
      <section style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={iconPlate}>
            <IconFileUp size={18} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 22, lineHeight: 1.2 }}>
              {t("cloud.title")}
            </h1>
            <p style={{ margin: "4px 0 0", color: "var(--muted-deep)", fontSize: 13 }}>
              {t("cloud.subtitle")}
            </p>
          </div>
        </header>

        <div className="glass-thin" style={panel}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              <span style={label}>{t("cloud.path")}</span>
              <input
                value={rootPath}
                onChange={(event) => setRootPath(event.target.value)}
                placeholder="/path/to/agent"
                style={input}
              />
            </label>
            <button onClick={chooseFolder} style={secondaryButton}>
              <IconFileUp size={13} />
              {t("cloud.pick_folder")}
            </button>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
            <span style={label}>{t("cloud.review_mode")}</span>
            <SegmentButton
              active={reviewMode === "static-only"}
              onClick={() => setReviewMode("static-only")}
              icon={<IconShield size={13} />}
              label={t("cloud.review.static")}
            />
            <SegmentButton
              active={reviewMode === "local-runtime"}
              onClick={() => setReviewMode("local-runtime")}
              icon={<IconKey size={13} />}
              label={t("cloud.review.local")}
            />
            <span style={{ color: "var(--muted-deep)", fontSize: 12, marginLeft: "auto" }}>
              {reviewMode === "local-runtime"
                ? `${t("cloud.cost.submitter")}${activeRuntime ? ` · ${runtimeLabel(activeRuntime)}` : ""}`
                : t("cloud.cost.none")}
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button
              onClick={() => void run("dry-run")}
              disabled={running !== null}
              style={secondaryButton}
            >
              <IconShield size={13} />
              {running === "dry-run" ? "..." : t("cloud.dry_run")}
            </button>
            <button
              onClick={() => void run("publish")}
              disabled={running !== null}
              style={primaryButton}
            >
              <IconStore size={13} />
              {running === "publish" ? "..." : t("cloud.publish")}
            </button>
          </div>

          {/* Hephaestus 엔진(upload.py) 직접 검수/업로드 — 임베딩된 오픈소스 엔진의 실제 패키징·보안·publish */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--paper-edge)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <IconShield size={13} style={{ color: "var(--accent)" }} />
              <span style={{ ...label, marginBottom: 0 }}>Hephaestus 엔진 직접 검수·업로드</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => void engineReview()} disabled={hephRunning !== null} style={secondaryButton}>
                <IconShield size={13} />
                {hephRunning === "review" ? "검수 중…" : "엔진 정적 검수"}
              </button>
              <button onClick={() => void enginePublish("private-link")} disabled={hephRunning !== null} style={secondaryButton}>
                <IconFileUp size={13} />
                {hephRunning === "private-link" ? "업로드 중…" : "엔진 Cloud 업로드"}
              </button>
              <button onClick={() => void enginePublish("marketplace")} disabled={hephRunning !== null} style={primaryButton}>
                <IconStore size={13} />
                {hephRunning === "marketplace" ? "업로드 중…" : "엔진 Hub 업로드"}
              </button>
            </div>
            {hephMsg && (
              <div
                style={{
                  ...notice,
                  marginTop: 10,
                  borderColor: hephMsg.ok ? "rgba(12,166,120,0.34)" : "rgba(201,58,58,0.34)",
                  color: hephMsg.ok ? "var(--green-deep)" : "var(--red-deep)",
                }}
              >
                {hephMsg.text}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div style={{ ...notice, borderColor: "rgba(201,58,58,0.34)", color: "var(--red-deep)" }}>
            {error}
          </div>
        )}

        {result && (
          <div className="glass-thin" style={panel}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ ...iconPlate, color: result.status === "blocked" ? "var(--red-deep)" : "var(--green-deep)" }}>
                <IconCheck size={17} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--muted-deep)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
                  {t("cloud.result")}
                </div>
                <h2 style={{ margin: "2px 0 0", fontSize: 17, fontFamily: "var(--font-head)" }}>
                  {statusLabel}
                </h2>
              </div>
              {result.registration?.marketplaceUrl && (
                <a href={result.registration.marketplaceUrl} target="_blank" rel="noreferrer" style={secondaryButton}>
                  <IconStore size={13} />
                  {t("cloud.open_market")}
                </a>
              )}
              {!result.registration?.marketplaceUrl && result.status === "registered" && (
                <Link href="/marketplace?tab=agents" style={secondaryButton}>
                  <IconStore size={13} />
                  {t("cloud.open_market")}
                </Link>
              )}
            </div>

            <div style={metricsGrid}>
              <Metric label={t("cloud.status")} value={result.status} />
              <Metric label={t("cloud.package")} value={result.manifest.slug} />
              <Metric label={t("cloud.files")} value={`${result.manifest.includedFileCount}/${result.manifest.fileCount}`} />
              <Metric label={t("cloud.hash")} value={result.manifest.packageHash.slice(0, 16)} mono />
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={label}>{t("cloud.findings")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {result.review.findings.length === 0 ? (
                  <div style={notice}>{t("cloud.no_findings")}</div>
                ) : (
                  result.review.findings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        ...secondaryButton,
        background: active ? "var(--fill-1)" : "var(--paper)",
        borderColor: active ? "var(--accent)" : "var(--paper-edge)",
        color: active ? "var(--accent)" : "var(--ink-soft)",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ padding: 10, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)", background: "var(--paper)" }}>
      <div style={{ fontSize: 10, color: "var(--muted-deep)", textTransform: "uppercase", fontFamily: "var(--font-mono)" }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 13,
          color: "var(--ink)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-body)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function FindingRow({ finding }: { finding: CloudAgentSecurityFinding }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: 10, borderRadius: "var(--radius-sm)", border: "1px solid var(--paper-edge)", background: "var(--paper)" }}>
      <span style={{ ...severityDot(finding.severity), flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{finding.severity}</span>
          {finding.file && (
            <span style={{ fontSize: 11, color: "var(--muted-deep)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {finding.file}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 2 }}>{finding.message}</div>
        {finding.remediation && (
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)", marginTop: 4 }}>{finding.remediation}</div>
        )}
      </div>
    </div>
  );
}

function runtimeLabel(status: RuntimeStatus): string {
  if (status.kind === "byok") return `BYOK · ${status.backend}${status.model ? ` · ${status.model}` : ""}`;
  if (status.kind === "ollama") return `Ollama${status.model ? ` · ${status.model}` : ""}`;
  return status.kind;
}

function severityDot(severity: CloudAgentSecurityFinding["severity"]): CSSProperties {
  const color =
    severity === "blocker" || severity === "high"
      ? "var(--red-deep)"
      : severity === "medium"
        ? "var(--amber-deep)"
        : "var(--green-deep)";
  return { width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 6 };
}

const panel: CSSProperties = {
  padding: 16,
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--glass-border)",
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

const label: CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--muted-deep)",
};

const input: CSSProperties = {
  width: "100%",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-sm)",
  padding: "9px 10px",
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
};

const secondaryButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "8px 12px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: "none",
  boxShadow: "var(--neu-raised)",
};

const primaryButton: CSSProperties = {
  ...secondaryButton,
  color: "var(--ink)",
  boxShadow: "var(--neu-raised-strong)",
};

const notice: CSSProperties = {
  padding: "9px 11px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-sm)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 12.5,
};

const metricsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 8,
  marginTop: 16,
};
