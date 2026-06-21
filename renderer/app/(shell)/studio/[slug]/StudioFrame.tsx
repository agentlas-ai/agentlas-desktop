// Studio web 임베드 — 클라이언트. useParams()의 slug로 forge web 패키지를 serve해서
// 받은 localhost url을 전체화면 iframe으로 띄운다.
//
// 흐름: mount → window.agentlas.studio.serve(slug) → { url } → iframe src.
// 상태: loading(스피너) / ready(iframe) / error(사람이 읽는 메시지).
// (shell) 레이아웃 아래라 Sidebar와 함께 뜬다.
"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { findStudioPackage } from "@/lib/studio-packages";
import { useT, pickLocalized } from "@/lib/i18n";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };

export function StudioFrame() {
  const params = useParams();
  const slugParam = params?.slug;
  const slug = Array.isArray(slugParam) ? slugParam[0] : (slugParam ?? "");
  const { locale } = useT();
  const pkg = useMemo(() => findStudioPackage(slug), [slug]);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });

    if (!slug) {
      setPhase({ kind: "error", message: "스튜디오를 찾을 수 없습니다." });
      return;
    }
    if (!pkg) {
      setPhase({ kind: "error", message: `알 수 없는 스튜디오입니다: ${slug}` });
      return;
    }

    const bridge = ipc();
    const studio = bridge?.studio;
    if (!studio?.serve) {
      // window.agentlas가 없음 — 브라우저 미리보기 등 데스크탑 런타임 밖.
      setPhase({
        kind: "error",
        message:
          "데스크탑 런타임에서만 열 수 있습니다 (Agentlas 데스크탑 앱에서 실행하세요).",
      });
      return;
    }

    studio
      .serve(slug)
      .then((res) => {
        if (cancelled) return;
        if (res && "url" in res && res.url) {
          setPhase({ kind: "ready", url: res.url });
        } else {
          const e = res as { error?: string; message?: string } | undefined;
          setPhase({
            kind: "error",
            message: e?.message ?? "스튜디오 서버를 시작하지 못했습니다.",
          });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message:
            e instanceof Error ? e.message : "스튜디오 서버를 시작하지 못했습니다.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [slug, pkg]);

  const title = pkg ? pickLocalized(pkg, locale).name : slug;

  if (phase.kind === "ready") {
    return (
      <iframe
        title={title}
        src={phase.url}
        style={{ width: "100%", height: "100%", border: 0, display: "block" }}
        // forge web 패키지(로컬 신뢰 코드)만 임베드 — 외부 페이지가 들어오지 않는다.
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads"
        allow="clipboard-read; clipboard-write"
      />
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        textAlign: "center",
        color: "var(--ink)",
        background: "var(--paper)",
      }}
    >
      {phase.kind === "loading" ? (
        <>
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "3px solid var(--paper-edge)",
              borderTopColor: pkg?.accent ?? "var(--accent)",
              animation: "studio-spin 0.8s linear infinite",
            }}
          />
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>
            스튜디오를 시작하는 중…
          </div>
          <style>{`@keyframes studio-spin { to { transform: rotate(360deg); } }`}</style>
        </>
      ) : (
        <>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--muted-deep)",
              maxWidth: 420,
              lineHeight: 1.5,
            }}
          >
            {phase.message}
          </div>
        </>
      )}
    </div>
  );
}
