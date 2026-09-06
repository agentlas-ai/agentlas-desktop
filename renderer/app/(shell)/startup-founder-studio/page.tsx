"use client";
// Startup opens the real Hub cloud package GUI. The renderer only hosts the launcher URL.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { IconChevronRight, IconRefresh } from "@/components/Icon";
import { StudioBotLogo } from "@/components/StudioBotLogo";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

type Phase = "starting" | "ready" | "error";

const IDEA_KEY = "agentlas.startupFounder.idea";
const STARTUP_NAME_KO = "스타트업 창업자 스튜디오";
const STARTUP_NAME_EN = "Startup Founder Studio";
const STARTUP_SLUG = "agentlas-startup-founder-studio";

export default function StartupFounderStudioPage() {
  const { locale } = useT();
  const [phase, setPhase] = useState<Phase>("starting");
  const [url, setUrl] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [ideaPromptOpen, setIdeaPromptOpen] = useState(false);
  const [ideaDraft, setIdeaDraft] = useState("");
  const startedRef = useRef(false);
  const loadWatchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = async (idea?: string) => {
    const trimmedIdea = idea?.trim() ?? "";
    const api = ipc();
    setPhase("starting");
    setReason("");
    setIdeaPromptOpen(false);
    if (loadWatchRef.current) clearTimeout(loadWatchRef.current);
    const timeout = new Promise<{ ok: false; reason: string }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            reason: locale === "ko" ? "스튜디오 서버 시작 시간 초과." : "Studio server startup timed out.",
          }),
        45_000,
      ),
    );

    let res: { ok: boolean; url?: string; reason?: string } | undefined;
    try {
      res = await Promise.race([
        api?.hephaestus.startStudio(trimmedIdea ? { idea: trimmedIdea } : undefined) ?? Promise.resolve(undefined),
        timeout,
      ]);
    } catch (e) {
      res = { ok: false, reason: (e as Error).message };
    }

    if (res?.ok && res.url) {
      const params = new URLSearchParams({ t: String(Date.now()) });
      setUrl(`${res.url}?${params.toString()}`);
      setPhase("ready");
      loadWatchRef.current = setTimeout(() => {
        setReason(locale === "ko" ? "스튜디오 화면을 불러오지 못했습니다." : "Failed to load the studio screen.");
        setPhase("error");
      }, 15_000);
      return;
    }

    setReason(res?.reason ?? (locale === "ko" ? "스튜디오를 시작할 수 없습니다." : "Unable to start the studio."));
    setPhase("error");
  };

  const onFrameLoad = () => {
    if (loadWatchRef.current) clearTimeout(loadWatchRef.current);
    loadWatchRef.current = null;
  };

  const onFrameError = () => {
    if (loadWatchRef.current) clearTimeout(loadWatchRef.current);
    setReason(locale === "ko" ? "스튜디오 화면 로드 실패." : "Studio screen failed to load.");
    setPhase("error");
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let savedIdea = "";
    try {
      savedIdea = window.sessionStorage.getItem(IDEA_KEY) ?? "";
    } catch {
      // ignore
    }
    if (savedIdea && savedIdea !== "__skip__") setIdeaDraft(savedIdea);
    void start();
    return () => {
      if (loadWatchRef.current) clearTimeout(loadWatchRef.current);
    };
  }, []);

  const studioReady = phase === "ready" && Boolean(url);

  return (
    <div style={shell}>
      <header className="titlebar-drag" style={header}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconChevronRight size={14} style={{ transform: "rotate(180deg)" }} /> Apps
        </Link>
        <div style={divider} />
        <StudioBotLogo size={32} />
        <div style={{ minWidth: 0 }}>
          <h1 style={title}>{locale === "ko" ? STARTUP_NAME_KO : STARTUP_NAME_EN}</h1>
          {locale === "ko" ? <p style={subtitle}>{STARTUP_NAME_EN}</p> : null}
        </div>
        <button
          onClick={() => setIdeaPromptOpen(true)}
          disabled={!studioReady}
          className="titlebar-nodrag"
          style={{
            ...ghostButton,
            marginLeft: "auto",
            opacity: studioReady ? 1 : 0.52,
            cursor: phase === "starting" ? "wait" : studioReady ? "pointer" : "not-allowed",
          }}
          title={
            !studioReady
              ? locale === "ko"
                ? phase === "starting"
                  ? "스튜디오 요청 브리지를 준비하는 중입니다."
                  : "먼저 스튜디오를 다시 시작해 주세요."
                : phase === "starting"
                  ? "Preparing the Studio request bridge."
                  : "Restart the Studio first."
              : undefined
          }
        >
          {locale === "ko" ? "새 아이디어" : "New Idea"}
        </button>
        <button
          onClick={() => void start()}
          disabled={phase === "starting"}
          className="titlebar-nodrag"
          title={locale === "ko" ? "다시 시작" : "Restart"}
          style={{ ...ghostButton, opacity: phase === "starting" ? 0.52 : 1 }}
        >
          <IconRefresh size={13} /> {locale === "ko" ? "새로고침" : "Refresh"}
        </button>
      </header>

      <div style={stage}>
        {ideaPromptOpen ? (
          <IdeaStartOverlay
            locale={locale}
            value={ideaDraft}
            onChange={setIdeaDraft}
            onSubmit={() => {
              try {
                window.sessionStorage.setItem(IDEA_KEY, ideaDraft.trim() || "__skip__");
              } catch {
                // ignore
              }
              void start(ideaDraft);
            }}
            onSkip={() => {
              try {
                window.sessionStorage.setItem(IDEA_KEY, "__skip__");
              } catch {
                // ignore
              }
              void start();
            }}
          />
        ) : phase === "ready" && url ? (
          <iframe
            key={url}
            src={url}
            title={locale === "ko" ? STARTUP_NAME_KO : STARTUP_NAME_EN}
            onLoad={onFrameLoad}
            onError={onFrameError}
            style={iframe}
            allow="clipboard-write; clipboard-read"
          />
        ) : (
          <LaunchState phase={phase} reason={reason} onRetry={() => void start()} locale={locale} />
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: "@keyframes sfsSpin{to{transform:rotate(360deg)}} .sfs-spin{animation:sfsSpin .8s linear infinite}" }} />
    </div>
  );
}

function VideoBackdrop() {
  return (
    <>
      <video src="/apps/startup-founder-studio.mp4" poster="/apps/startup-founder-studio.png" autoPlay muted loop playsInline style={video} />
      <div style={shade} />
    </>
  );
}

function LaunchState({
  phase,
  reason,
  onRetry,
  locale,
}: {
  phase: Phase;
  reason: string;
  onRetry: () => void;
  locale: Locale;
}) {
  return (
    <div style={stateLayer}>
      <VideoBackdrop />
      <div style={statePanel}>
        <StudioBotLogo size={54} />
        <div>
          <div style={stateName}>{locale === "ko" ? STARTUP_NAME_KO : STARTUP_NAME_EN}</div>
          <div style={stateSlug}>{STARTUP_SLUG}</div>
        </div>
        {phase === "starting" ? (
          <>
            <div className="sfs-spin" style={spinner} />
            <div style={stateText}>{locale === "ko" ? "GUI 런처를 시작하는 중" : "Starting the GUI launcher"}</div>
          </>
        ) : (
          <>
            <div style={stateText}>
              {locale === "ko" ? "GUI 런처를 시작할 수 없습니다" : "Unable to start the GUI launcher"}
            </div>
            <div style={errorText}>{reason}</div>
            <button onClick={onRetry} style={solidButton}>
              {locale === "ko" ? "다시 시도" : "Try Again"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function IdeaStartOverlay({
  value,
  onChange,
  onSubmit,
  onSkip,
  locale,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  locale: Locale;
}) {
  return (
    <div style={stateLayer}>
      <VideoBackdrop />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        style={ideaPanel}
      >
        <StudioBotLogo size={44} />
        <div>
          <h2 style={ideaTitle}>{locale === "ko" ? STARTUP_NAME_KO : STARTUP_NAME_EN}</h2>
          <p style={ideaSlug}>{STARTUP_SLUG}</p>
        </div>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoFocus
          placeholder={locale === "ko" ? "창업 아이디어 한 줄" : "Describe your startup idea in one line"}
          style={ideaInput}
        />
        <div style={ideaActions}>
          <button type="button" onClick={onSkip} style={outlineButton}>
            {locale === "ko" ? "건너뛰기" : "Skip"}
          </button>
          <button type="submit" style={solidButton}>
            {locale === "ko" ? "시작" : "Start"}
          </button>
        </div>
      </form>
    </div>
  );
}

const shell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "var(--black)",
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 24px 12px 90px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  minHeight: 58,
  flexShrink: 0,
  background: "var(--black)",
  color: "var(--white)",
};

const backLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 13,
  color: "rgba(247,248,255,0.68)",
  textDecoration: "none",
};

const divider: CSSProperties = {
  width: 1,
  height: 20,
  background: "rgba(255,255,255,0.14)",
};

const title: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-head)",
  fontSize: 16,
  color: "var(--white)",
  whiteSpace: "nowrap",
};

const subtitle: CSSProperties = {
  margin: "2px 0 0",
  fontSize: 11.5,
  color: "rgba(247,248,255,0.54)",
};

const ghostButton: CSSProperties = {
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "var(--white)",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 7,
  padding: "0 11px",
  cursor: "pointer",
};

const stage: CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
  background: "var(--black)",
};

const iframe: CSSProperties = {
  width: "100%",
  height: "100%",
  border: "none",
  display: "block",
  background: "var(--black)",
};

const stateLayer: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
  overflow: "hidden",
  padding: 28,
};

const video: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  filter: "saturate(1.04) contrast(1.06)",
};

const shade: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(90deg, rgba(5,7,12,0.94), rgba(5,7,12,0.66) 48%, rgba(5,7,12,0.88)), linear-gradient(0deg, rgba(5,7,12,0.94), rgba(5,7,12,0.22) 58%, rgba(5,7,12,0.64))",
};

const statePanel: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "min(430px, 100%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 14,
  padding: 24,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(11,15,24,0.72)",
  boxShadow: "0 28px 90px rgba(0,0,0,0.36)",
  backdropFilter: "blur(18px)",
  color: "var(--white)",
  textAlign: "center",
};

const stateName: CSSProperties = {
  fontSize: 18,
  fontWeight: 820,
  color: "var(--white)",
};

const stateSlug: CSSProperties = {
  marginTop: 4,
  fontSize: 11.5,
  color: "rgba(247,248,255,0.58)",
  fontFamily: "var(--font-mono)",
};

const spinner: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "3px solid rgba(255,255,255,0.18)",
  borderTopColor: "var(--info-soft)",
};

const stateText: CSSProperties = {
  fontSize: 13,
  color: "rgba(247,248,255,0.74)",
};

const errorText: CSSProperties = {
  maxWidth: 360,
  fontSize: 12.5,
  lineHeight: 1.55,
  color: "rgba(247,248,255,0.62)",
};

const ideaPanel: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "min(480px, 100%)",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 22,
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(11,15,24,0.76)",
  boxShadow: "0 28px 90px rgba(0,0,0,0.36)",
  backdropFilter: "blur(18px)",
};

const ideaTitle: CSSProperties = {
  margin: 0,
  color: "var(--white)",
  fontFamily: "var(--font-head)",
  fontSize: 22,
  lineHeight: 1.2,
};

const ideaSlug: CSSProperties = {
  margin: "5px 0 0",
  color: "rgba(247,248,255,0.58)",
  fontSize: 11.5,
  fontFamily: "var(--font-mono)",
};

const ideaInput: CSSProperties = {
  height: 46,
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.08)",
  color: "var(--white)",
  outline: "none",
  padding: "0 13px",
  fontSize: 14,
};

const ideaActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  flexWrap: "wrap",
};

const outlineButton: CSSProperties = {
  height: 38,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "transparent",
  color: "rgba(247,248,255,0.74)",
  padding: "0 14px",
  fontSize: 13,
  cursor: "pointer",
};

const solidButton: CSSProperties = {
  height: 38,
  borderRadius: 8,
  border: "none",
  background: "var(--info-soft)",
  color: "var(--info)",
  padding: "0 16px",
  fontSize: 13,
  fontWeight: 820,
  cursor: "pointer",
};
