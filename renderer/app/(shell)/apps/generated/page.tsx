"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconApps, IconChevronRight, IconEdit, IconFileUp, IconTrash } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { demoGeneratedApp } from "@/lib/generated-app-engine";
import type { AppFactoryAppRecord } from "@/lib/types";
import { sanitizePublicAppCopy } from "@shared/brand-safety";

function queryAppId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
}

export default function GeneratedAppPage() {
  const { locale } = useT();
  const router = useRouter();
  const [app, setApp] = useState<AppFactoryAppRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const id = queryAppId();
    const api = ipc();
    if (!api || !id) {
      setApp(id ? demoGeneratedApp(id, locale) : null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    void api.appFactory.getApp(id).then((record) => {
      if (!cancelled) {
        setApp(record ?? demoGeneratedApp(id, locale));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const appName = sanitizePublicAppCopy(app?.appName || app?.manifest?.app?.name || app?.manifest?.title, "Generated App");

  if (loading) {
    return (
      <GeneratedShell title="Generated App" subtitle={locale === "en" ? "Loading App" : "App 로딩 중"}>
        <div style={emptyState}>{locale === "en" ? "Loading..." : "불러오는 중..."}</div>
      </GeneratedShell>
    );
  }

  if (!app) {
    return (
      <GeneratedShell title="Generated App" subtitle={locale === "en" ? "Not found" : "찾을 수 없음"}>
        <div style={emptyState}>
          {locale === "en" ? "This generated App is not available." : "이 생성 App을 찾을 수 없습니다."}
        </div>
      </GeneratedShell>
    );
  }

  async function deleteCurrentApp() {
    const api = ipc();
    if (!api || !app || deleting) return;
    const ok = window.confirm(
      locale === "en"
        ? `Delete ${appName} from Apps? It will be kept as a reversible archive.`
        : `${appName}을 Apps에서 삭제할까요? 복원 가능한 archive로 보관됩니다.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await api.appFactory.archive({ rootPath: app.rootPath });
      router.push("/apps");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  const editPrompt = encodeURIComponent(`@${appName} ${locale === "en" ? "edit this App" : "이 App 수정해줘"}`);

  return (
    <GeneratedShell
      title={appName}
      subtitle={sanitizePublicAppCopy(app.manifest?.domain || app.manifest?.layout, app.manifest?.layout)}
      actions={
        <>
          <Link
            href={`/chat?id=${app.chatId}&prompt=${editPrompt}&permission=write`}
            className="titlebar-nodrag"
            style={headerAction}
          >
            <IconEdit size={13} />
            {locale === "en" ? "Edit" : "수정"}
          </Link>
          <button
            type="button"
            className="titlebar-nodrag"
            onClick={() => void deleteCurrentApp()}
            disabled={deleting}
            style={headerAction}
          >
            <IconTrash size={13} />
            {locale === "en" ? "Delete" : "삭제"}
          </button>
        </>
      }
    >
      <ExternalGeneratedAppManager app={app} />
    </GeneratedShell>
  );
}

function GeneratedShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={pageShell}>
      <header className="titlebar-drag glass-thin" style={appHeader}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconApps size={15} />
          Apps
        </Link>
        <IconChevronRight size={12} style={{ color: "var(--muted)" }} />
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <h1 style={appTitle}>{title}</h1>
          <div style={appSubtitle}>{subtitle}</div>
        </div>
        <div className="titlebar-nodrag" style={localPill}>
          <span style={liveDot} />
          Local Web App
        </div>
        {actions ? <div style={headerActions}>{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

function ExternalGeneratedAppManager({ app }: { app: AppFactoryAppRecord }) {
  const { locale } = useT();
  const [busy, setBusy] = useState<"open" | "smoke" | "preview" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const launchUrl = appLaunchUrl(app);
  const devCommand = appDevCommand(app);
  const runtimeMode = app.scaffold.runtimeMode || (app.rootPath.startsWith("agentlas-cloud://") ? "cloud-manifest" : "external-local-webapp");
  const runtimeLabel = runtimeMode.replace(/-/g, " ");
  const isCloudOnly = app.rootPath.startsWith("agentlas-cloud://");
  const files = [
    { label: locale === "en" ? "Root" : "루트", value: app.rootPath },
    { label: locale === "en" ? "Launch URL" : "실행 URL", value: launchUrl || "" },
    { label: locale === "en" ? "Dev command" : "실행 명령", value: devCommand },
    { label: locale === "en" ? "Setup" : "설정 파일", value: app.setupPath },
    { label: locale === "en" ? "Smoke" : "스모크", value: app.smokePath },
  ].filter((item) => item.value);

  async function copy(value: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(value);
      setMessage(locale === "en" ? "Copied." : "복사했습니다.");
    } catch {
      setMessage(locale === "en" ? `Copy unavailable. Select this value: ${value}` : `복사 권한이 없습니다. 이 값을 선택해 사용하세요: ${value}`);
    }
  }

  async function openLaunchTarget() {
    const api = ipc();
    setBusy("open");
    try {
      if (api) {
        const result = await api.appFactory.openLaunchTarget({ rootPath: app.rootPath });
        setMessage(result.summary);
      } else if (launchUrl) {
        window.open(launchUrl, "_blank", "noopener,noreferrer");
        setMessage(locale === "en" ? `Opened ${launchUrl}.` : `${launchUrl} 열기를 요청했습니다.`);
      } else {
        setMessage(locale === "en" ? "No launch URL is registered." : "등록된 실행 URL이 없습니다.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runSmoke() {
    const api = ipc();
    if (!api || isCloudOnly) return;
    setBusy("smoke");
    try {
      const result = await api.appFactory.runSmoke({ rootPath: app.rootPath });
      setMessage(result.ok ? `Smoke passed: ${result.command}` : `Smoke failed: ${result.stderr || result.stdout || result.command}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function preparePreview() {
    const api = ipc();
    if (!api || isCloudOnly) return;
    setBusy("preview");
    try {
      const result = await api.appFactory.preparePreview({ rootPath: app.rootPath });
      setMessage(`${locale === "en" ? "Preview package ready" : "미리보기 패키지 준비됨"}: ${result.previewPath}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main style={managerShell}>
      <section style={managerHero}>
        <div style={{ minWidth: 0 }}>
          <div style={managerEyebrow}>{runtimeLabel}</div>
          <h2 style={managerTitle}>{app.appName || app.manifest?.app?.name || app.manifest?.title}</h2>
          <p style={managerCopy}>
            {locale === "en"
              ? "This generated App stays listed in Agentlas. The user app runs outside the Desktop renderer as a localhost web app."
              : "이 생성 App은 Agentlas 목록에 남기고, 실제 사용자 앱은 Desktop renderer 밖의 localhost 웹앱으로 실행합니다."}
          </p>
        </div>
        <div style={managerActions}>
          <button type="button" onClick={() => void openLaunchTarget()} disabled={busy === "open"} style={primaryBtn}>
            <IconChevronRight size={13} />
            {busy === "open" ? (locale === "en" ? "Opening" : "여는 중") : (locale === "en" ? "Open local app" : "로컬 앱 열기")}
          </button>
          {launchUrl ? (
            <button type="button" onClick={() => void copy(launchUrl)} style={secondaryBtn}>
              {locale === "en" ? "Copy URL" : "URL 복사"}
            </button>
          ) : null}
        </div>
      </section>

      <section style={managerGrid}>
        <article style={panel}>
          <h3 style={panelTitle}>{locale === "en" ? "Run command" : "실행 명령"}</h3>
          <button type="button" onClick={() => void copy(devCommand)} style={codeBlockButton}>
            <code>{devCommand}</code>
          </button>
          <div style={{ ...noteBox, marginTop: 12 }}>
            {locale === "en"
              ? "Run this from the generated app root. Change PORT when another local app already uses this port."
              : "생성 앱 루트에서 실행하세요. 같은 포트를 이미 쓰고 있으면 PORT 값을 바꾸면 됩니다."}
          </div>
        </article>

        <article style={panel}>
          <h3 style={panelTitle}>{locale === "en" ? "Registry state" : "등록 상태"}</h3>
          <SummaryRow label="Status" value={app.status} />
          <SummaryRow label="Domain" value={app.domain || app.manifest?.domain || "generated-app"} />
          <SummaryRow label="Files" value={String(app.scaffold.files.length)} />
          <SummaryRow label="Updated" value={new Date(app.updatedAt).toLocaleString()} />
        </article>
      </section>

      <section style={panel}>
        <div style={workTop}>
          <div style={{ minWidth: 0 }}>
            <h3 style={panelTitle}>{locale === "en" ? "Files and launch metadata" : "파일과 실행 메타데이터"}</h3>
            <div style={workMeta}>
              {locale === "en" ? "Desktop keeps references only; the app UI runs in the external web process." : "Desktop은 참조만 보관하고, 앱 UI는 외부 웹 프로세스에서 실행됩니다."}
            </div>
          </div>
          <div style={toolbar}>
            <button type="button" onClick={() => void runSmoke()} disabled={busy === "smoke" || isCloudOnly} style={secondaryBtn}>
              {busy === "smoke" ? "..." : "Smoke"}
            </button>
            <button type="button" onClick={() => void preparePreview()} disabled={busy === "preview" || isCloudOnly} style={secondaryBtn}>
              <IconFileUp size={13} />
              {busy === "preview" ? "..." : (locale === "en" ? "Package preview" : "미리보기 패키지")}
            </button>
          </div>
        </div>
        <div style={fileList}>
          {files.map((item) => (
            <button key={item.label} type="button" onClick={() => void copy(item.value)} style={fileRow}>
              <strong>{item.label}</strong>
              <span>{item.value}</span>
            </button>
          ))}
        </div>
        {message ? <div style={managerMessage}>{message}</div> : null}
      </section>
    </main>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={summaryRow}>
      <strong>{label}</strong>
      <span style={summaryValue}>{value}</span>
    </div>
  );
}

function appLaunchUrl(app: AppFactoryAppRecord): string | null {
  const launchUrl = app.scaffold.launchUrl || (/^https?:\/\//.test(app.previewPath) ? app.previewPath : "");
  return launchUrl || null;
}

function appDevCommand(app: AppFactoryAppRecord): string {
  if (app.scaffold.devCommand) return app.scaffold.devCommand;
  const port = app.scaffold.localPort || 3000;
  return `PORT=${port} node scripts/serve.mjs`;
}

const pageShell: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
};

const appHeader: CSSProperties = {
  minHeight: 52,
  borderBottom: "1px solid var(--glass-border)",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 20px 8px 90px",
  flexShrink: 0,
  flexWrap: "wrap",
};

const backLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  color: "var(--ink-soft)",
  textDecoration: "none",
  fontWeight: 800,
  fontSize: 12,
};

const appTitle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontFamily: "var(--font-head)",
  fontSize: 16,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const appSubtitle: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 11.5,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const localPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--paper-edge)",
  borderRadius: 999,
  padding: "6px 9px",
  color: "var(--green-deep)",
  background: "var(--paper)",
  fontSize: 11,
  fontWeight: 900,
  whiteSpace: "nowrap",
};

const liveDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: "var(--green)",
  boxShadow: "0 0 0 3px rgba(69, 179, 103, .13)",
};

const headerActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const headerAction: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 30,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  padding: "7px 10px",
  color: "var(--ink-soft)",
  background: "var(--paper)",
  fontWeight: 850,
  fontSize: 12,
  textDecoration: "none",
};

const emptyState: CSSProperties = {
  margin: 24,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 18,
  color: "var(--muted-deep)",
  fontWeight: 750,
  background: "var(--panel)",
};

const managerShell: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "clamp(10px, 3vw, 24px)",
  display: "grid",
  gap: 14,
  alignContent: "start",
};

const managerHero: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--panel)",
  padding: "clamp(12px, 3vw, 22px)",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  gap: 18,
  alignItems: "center",
};

const managerEyebrow: CSSProperties = {
  color: "var(--accent)",
  fontSize: 11,
  fontWeight: 950,
  textTransform: "uppercase",
  marginBottom: 6,
  wordBreak: "keep-all",
  overflowWrap: "break-word",
};

const managerTitle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontFamily: "var(--font-head)",
  fontSize: 22,
  lineHeight: 1.08,
  wordBreak: "keep-all",
  overflowWrap: "break-word",
};

const managerCopy: CSSProperties = {
  margin: "10px 0 0",
  color: "var(--ink-soft)",
  lineHeight: 1.55,
  maxWidth: 660,
  fontWeight: 650,
};

const managerActions: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  justifyContent: "flex-end",
};

const managerGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
  gap: 14,
};

const panel: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: 16,
  boxShadow: "var(--shadow-1)",
  minWidth: 0,
};

const panelTitle: CSSProperties = {
  margin: "0 0 12px",
  color: "var(--ink)",
  fontSize: 13,
  fontFamily: "var(--font-head)",
  display: "flex",
  alignItems: "center",
  gap: 7,
};

const primaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 34,
  borderRadius: 8,
  border: "1px solid var(--accent)",
  color: "white",
  background: "var(--accent)",
  padding: "8px 12px",
  fontWeight: 900,
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 34,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  color: "var(--ink-soft)",
  background: "var(--paper)",
  padding: "8px 12px",
  fontWeight: 850,
  cursor: "pointer",
};

const codeBlockButton: CSSProperties = {
  width: "100%",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--fill-1)",
  padding: "12px 13px",
  color: "var(--ink)",
  textAlign: "left",
  overflowWrap: "anywhere",
  cursor: "copy",
};

const noteBox: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 12,
  color: "var(--muted-deep)",
  background: "var(--fill-1)",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.5,
};

const summaryRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(64px, 88px) minmax(0, 1fr)",
  gap: 10,
  alignItems: "start",
  padding: "9px 0",
  borderTop: "1px solid var(--paper-edge)",
  color: "var(--ink-soft)",
  fontSize: 12,
};

const summaryValue: CSSProperties = {
  minWidth: 0,
  color: "var(--ink)",
  fontWeight: 800,
  overflowWrap: "anywhere",
};

const workTop: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  marginBottom: 12,
};

const workMeta: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 12,
  fontWeight: 650,
  lineHeight: 1.4,
};

const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const fileList: CSSProperties = {
  display: "grid",
  gap: 8,
};

const fileRow: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--panel)",
  padding: "10px 12px",
  display: "grid",
  gridTemplateColumns: "minmax(64px, 110px) minmax(0, 1fr)",
  gap: 12,
  alignItems: "center",
  textAlign: "left",
  color: "var(--ink-soft)",
  cursor: "copy",
};

const managerMessage: CSSProperties = {
  marginTop: 12,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--fill-1)",
  color: "var(--ink-soft)",
  padding: 12,
  fontWeight: 750,
  overflowWrap: "anywhere",
};
